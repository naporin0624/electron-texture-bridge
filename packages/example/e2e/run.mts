// E2E for the example app — `pnpm --filter @napolab/texture-bridge-example e2e`
//
// Launches `electron-vite dev` with a free CDP port, waits for the
// multiviewer / receiver-test windows to settle (Vite may re-optimize deps and
// reload pages right after launch), drives both pages via CDP, asserts frames
// are actually drawn, and ALWAYS kills the whole app process group (pass,
// failure, timeout, SIGINT/SIGTERM). Exit 0 = pass, 1 = fail.
//
// Each page is raised with Page.bringToFront and must report
// visibilityState=visible with rAF ticking before it is judged. Then, with
// frames flowing, a full-display window is opened on top of it and the page
// must STILL report visible + rAF ticking + frames drawn: on macOS an occluded
// window otherwise turns "hidden" and runs no rAF, stalling the multiviewer's
// rAF draw loop (arrival > 0, draw = 0). The app opts its monitor windows out
// with `backgroundThrottling: false`; the e2e launches Electron WITHOUT any
// Chromium backgrounding switches so these checks prove that fix.
//
// Platform: macOS only for now — the receiver path and the multiviewer's
// syphon deck need Syphon. On other platforms it prints a skip and exits 0.
//
// Prerequisites: native addon built (packages/native/index.js + .node),
// vendor/Syphon.framework present, `pnpm build:core && pnpm build:renderer`.
//
// Runs as TypeScript via Node's built-in type stripping (Node >= 22.18),
// no tsx needed. Env knobs:
//   E2E_MIN_FPS     fps must be > this       (default 0)
//   E2E_MIN_LIT     lit samples must be > this (default 0)
//   E2E_TIMEOUT_MS  hard deadline for the run  (default 180000)
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { killApp, killAppSync, launchApp, pickFreePort, type AppProcess } from "./app-process.mts";
import { connectCDP, listPageTargets, type CDPSession, type PageTarget } from "./cdp.mts";
import {
  PageReloadedError,
  RAF_PROBE,
  runMultiviewer,
  runReceiver,
  type Check,
  type Thresholds,
} from "./checks.mts";

const EXAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(EXAMPLE_DIR, "..", "..");
const PAGES = { multiviewer: "multiviewer.html", receiver: "receiver-test.html" } as const;
const SETTLE_MS = 4000;
const SETTLE_CAP_MS = 45_000;
const TARGET_TIMEOUT_MS = 120_000;
const STARTUP_QUIET_MS = 3000;
const VISIBLE_TIMEOUT_MS = 10_000;

type Scenario = (session: CDPSession, t: Thresholds) => Promise<Check[]>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg: string): void => console.log(`[e2e] ${msg}`);

const envNumber = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
};

// ---------------------------------------------------------------- lifecycle

let app: AppProcess | undefined;
let shuttingDown: Promise<boolean> | undefined;

/** Idempotent: kill the app group once, whoever asks first. */
const shutdown = (): Promise<boolean> => {
  if (shuttingDown) return shuttingDown;
  const current = app;
  shuttingDown = current ? killApp(current.pgid) : Promise.resolve(true);
  return shuttingDown;
};

const findStrayElectron = (): string[] => {
  try {
    const out = execFileSync("pgrep", ["-fl", `${REPO_ROOT}.*lectron`], { encoding: "utf8" });
    return out.split("\n").filter((line) => line.trim() && !line.includes("pgrep"));
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
};

let finishing: Promise<never> | undefined;

/** First caller decides the exit code; later callers (e.g. main after a timeout) just wait. */
const finish = (code: number, reason?: string): Promise<never> => {
  finishing ??= finishOnce(code, reason);
  return finishing;
};

const finishOnce = async (code: number, reason?: string): Promise<never> => {
  if (reason) log(reason);
  const groupGone = await shutdown();
  const strays = findStrayElectron();
  if (!groupGone || strays.length > 0) {
    console.error(`[e2e] processes left after kill:\n${strays.join("\n")}`);
    process.exit(1);
  }
  log("app process group killed, no Electron processes left");
  process.exit(code);
};

const installSafetyNets = (): void => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void finish(130, `received ${signal}, killing app`));
  }
  process.on("uncaughtException", (err) => void finish(1, `uncaught: ${err.stack ?? err.message}`));
  process.on("unhandledRejection", (err) => void finish(1, `unhandled rejection: ${err}`));
  process.on("exit", () => {
    if (app) killAppSync(app.pgid);
  });
  const timeoutMs = envNumber("E2E_TIMEOUT_MS", 180_000);
  setTimeout(() => void finish(1, `FAIL: hard timeout ${timeoutMs}ms reached`), timeoutMs).unref();
};

// ------------------------------------------------------------- page access

const findTarget = (targets: PageTarget[], page: string): PageTarget | undefined =>
  targets.find((t) => t.url.includes(page));

const waitForTargets = async (current: AppProcess, port: number): Promise<void> => {
  const deadline = Date.now() + TARGET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (current.child.exitCode !== null)
      throw new Error(`app exited early (code ${current.child.exitCode})`);
    const targets = await listPageTargets(port).catch((): PageTarget[] => []);
    if (findTarget(targets, PAGES.multiviewer) && findTarget(targets, PAGES.receiver)) return;
    await sleep(500);
  }
  throw new Error(`page targets not found within ${TARGET_TIMEOUT_MS}ms`);
};

const openSession = async (port: number, page: string): Promise<CDPSession> => {
  const target = findTarget(await listPageTargets(port), page);
  if (!target) throw new Error(`target ${page} not found`);
  return connectCDP(target.webSocketDebuggerUrl);
};

/** Wait until no page load and no Vite reload has happened for SETTLE_MS. */
const waitSettled = async (current: AppProcess, session: CDPSession): Promise<void> => {
  const started = Date.now();
  let quietSince = Date.now();
  let lastLoads = session.loadCount();
  let lastVite = current.viteReloads();
  while (Date.now() - started < SETTLE_CAP_MS) {
    await sleep(250);
    if (session.isClosed()) throw new PageReloadedError("session closed while settling");
    const changed = session.loadCount() !== lastLoads || current.viteReloads() !== lastVite;
    if (changed) quietSince = Date.now();
    lastLoads = session.loadCount();
    lastVite = current.viteReloads();
    const ready = await session
      .evaluate<boolean>(`document.readyState === "complete"`)
      .catch(() => false);
    if (ready && Date.now() - quietSince >= SETTLE_MS) {
      log(
        `settled after ${Date.now() - started}ms (page loads seen=${lastLoads}, vite reloads=${lastVite})`,
      );
      return;
    }
  }
  log(`settle cap ${SETTLE_CAP_MS}ms reached, continuing`);
};

type Visibility = { visible: boolean; state: string; raf: number };

const ensureVisible = async (session: CDPSession): Promise<Visibility> => {
  const deadline = Date.now() + VISIBLE_TIMEOUT_MS;
  let last = { state: "unknown", raf: 0 };
  while (Date.now() < deadline) {
    await session.bringToFront();
    last = await session.evaluate<{ state: string; raf: number }>(RAF_PROBE);
    if (last.state === "visible" && last.raf > 0) return { visible: true, ...last };
  }
  return { visible: false, ...last };
};

const problemChecks = (label: string, session: CDPSession): Check[] => [
  {
    name: `${label} no console.error / exceptions`,
    pass: session.problems.length === 0,
    detail:
      session.problems.length === 0
        ? "clean"
        : session.problems.map((p) => `${p.kind}: ${p.text}`).join(" || "),
  },
];

const resetPage = async (session: CDPSession): Promise<void> => {
  // Best effort: release decks / receiver so a retry starts clean.
  await session
    .evaluate(`for (const b of document.querySelectorAll("button[id^=disconnect]")) b.click()`)
    .catch(() => undefined);
  session.close();
};

/** One attempt = fresh target lookup + settle + scenario + page-error check. */
const attemptScenario = async (
  current: AppProcess,
  port: number,
  label: string,
  page: string,
  scenario: Scenario,
  t: Thresholds,
): Promise<Check[]> => {
  const session = await openSession(port, page);
  try {
    await waitSettled(current, session);
    const visibility = await ensureVisible(session);
    const visibleCheck: Check = {
      name: `${label} window visible (rAF running)`,
      pass: visibility.visible,
      detail: `visibilityState=${visibility.state} rAF/s=${visibility.raf}`,
    };
    if (!visibility.visible) return [visibleCheck];
    const checks = await scenario(session, t);
    return [visibleCheck, ...checks, ...problemChecks(label, session)];
  } finally {
    await resetPage(session);
  }
};

const failed = (checks: Check[]): boolean => checks.some((c) => !c.pass);

const runWithRetry = async (
  current: AppProcess,
  port: number,
  label: string,
  page: string,
  scenario: Scenario,
  t: Thresholds,
): Promise<Check[]> => {
  const first = await attemptScenario(current, port, label, page, scenario, t).catch(
    (err: unknown) => [
      {
        name: `${label} attempt`,
        pass: false,
        detail: err instanceof Error ? err.message : `${err}`,
      },
    ],
  );
  if (!failed(first)) return first;
  log(`${label}: first attempt failed, retrying once with a fresh page lookup`);
  for (const c of first.filter((check) => !check.pass)) log(`  (attempt 1) ${c.name}: ${c.detail}`);
  return attemptScenario(current, port, label, page, scenario, t).catch((err: unknown) => [
    {
      name: `${label} attempt`,
      pass: false,
      detail: err instanceof Error ? err.message : `${err}`,
    },
  ]);
};

// ----------------------------------------------------------------- report

const printSummary = (checks: Check[]): void => {
  console.log("\n================ E2E summary ================");
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}\n      ${c.detail}`);
  const passed = checks.filter((c) => c.pass).length;
  console.log(
    `---------------------------------------------\n${passed}/${checks.length} checks passed`,
  );
};

// ------------------------------------------------------------------- main

type Session = { current: AppProcess; port: number };

const startApp = async (): Promise<Session> => {
  const port = await pickFreePort();
  log(`launching example app (CDP port ${port})`);
  const current = launchApp(EXAMPLE_DIR, port);
  app = current;
  await waitForTargets(current, port);
  // Vite's dep optimization ("new dependencies optimized: three") lands a few
  // seconds after the windows appear; give it a chance to show up in the log.
  await sleep(STARTUP_QUIET_MS);
  log(`page targets found (vite reloads so far: ${current.viteReloads()})`);
  return { current, port };
};

const runScenarios = async (session: Session, thresholds: Thresholds): Promise<Check[]> => {
  const { current, port } = session;
  const multiviewer = await runWithRetry(
    current,
    port,
    "multiviewer",
    PAGES.multiviewer,
    runMultiviewer,
    thresholds,
  );
  const receiver = await runWithRetry(
    current,
    port,
    "receiver",
    PAGES.receiver,
    runReceiver,
    thresholds,
  );
  return [...multiviewer, ...receiver];
};

const report = async (session: Session, checks: Check[]): Promise<never> => {
  printSummary(checks);
  if (!failed(checks)) return finish(0, "RESULT: PASS");
  console.log(`\n--- app log tail ---\n${session.current.logTail()}\n--------------------`);
  return finish(1, "RESULT: FAIL");
};

const main = async (): Promise<void> => {
  if (process.platform !== "darwin") {
    log(`skip: macOS-only (Syphon), platform is ${process.platform}`);
    process.exit(0);
  }
  installSafetyNets();

  const thresholds: Thresholds = {
    minFps: envNumber("E2E_MIN_FPS", 0),
    minLit: envNumber("E2E_MIN_LIT", 0),
  };
  log(`thresholds fps>${thresholds.minFps} lit>${thresholds.minLit}`);

  try {
    const session = await startApp();
    await report(session, await runScenarios(session, thresholds));
  } catch (err) {
    if (app) console.log(`\n--- app log tail ---\n${app.logTail()}\n--------------------`);
    await finish(1, `RESULT: FAIL (${err instanceof Error ? err.message : `${err}`})`);
  }
};

await main();
