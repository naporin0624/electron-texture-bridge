// Launch / kill the example app (electron-vite dev) as one process group.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

export type AppProcess = {
  child: ChildProcess;
  pgid: number;
  /** Rolling tail of stdout+stderr, printed on failure. */
  logTail: () => string;
  /** Times Vite reported a dependency re-optimization / full reload. */
  viteReloads: () => number;
  sawAppReady: () => boolean;
};

const LOG_TAIL_LINES = 80;
const VITE_RELOAD_PATTERN =
  /new dependencies optimized|optimized dependencies changed|page reload/i;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const pickFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });

export const launchApp = (exampleDir: string, port: number): AppProcess => {
  const bin = join(exampleDir, "node_modules", ".bin", "electron-vite");
  // detached => the child leads a new process group, so electron-vite, vite,
  // Electron and every Electron helper can be signalled together via -pgid.
  // No Chromium backgrounding switches on purpose: the monitor windows opt out
  // of occlusion throttling themselves (`backgroundThrottling: false`), and the
  // covered-window checks exist to prove that app-level fix.
  const child = spawn(bin, ["dev", "--remoteDebuggingPort", `${port}`], {
    cwd: exampleDir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const pgid = child.pid;
  if (pgid === undefined) throw new Error("failed to spawn electron-vite");

  const lines: string[] = [];
  let reloads = 0;
  let appReady = false;
  // Pipes must be drained continuously or electron-vite stalls on a full buffer.
  const onData = (chunk: Buffer): void => {
    for (const line of `${chunk}`.split("\n")) {
      if (!line.trim()) continue;
      lines.push(line);
      if (VITE_RELOAD_PATTERN.test(line)) reloads += 1;
      if (line.includes("[example] app ready")) appReady = true;
    }
    if (lines.length > LOG_TAIL_LINES) lines.splice(0, lines.length - LOG_TAIL_LINES);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  return {
    child,
    pgid,
    logTail: () => lines.join("\n"),
    viteReloads: () => reloads,
    sawAppReady: () => appReady,
  };
};

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: group already gone.
  }
};

const waitGroupGone = async (pgid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true;
    await sleep(100);
  }
  return !groupAlive(pgid);
};

/** SIGTERM the whole group, SIGKILL after a grace period. Resolves true when nothing is left. */
export const killApp = async (pgid: number, graceMs = 4000): Promise<boolean> => {
  signalGroup(pgid, "SIGTERM");
  if (await waitGroupGone(pgid, graceMs)) return true;
  signalGroup(pgid, "SIGKILL");
  return waitGroupGone(pgid, 3000);
};

/** Last-resort synchronous kill for `process.on("exit")`. */
export const killAppSync = (pgid: number): void => {
  signalGroup(pgid, "SIGKILL");
};
