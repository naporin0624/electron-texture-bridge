// Scenario checks driven through CDP Runtime.evaluate. The example windows run
// with contextIsolation:false, so the page's DOM is directly scriptable.
import type { CDPSession } from "./cdp.mts";

export type Check = { name: string; pass: boolean; detail: string };

export type Thresholds = { minFps: number; minLit: number };

/** Own sources only — external Syphon senders (e.g. "Genovese Output") may be black. */
export const OWN_SENDER = "ElectronVJ-ThreeJS";
const RECEIVER_FPS_WINDOW_MS = 1500;
const MULTIVIEWER_PLAN = [`local:${OWN_SENDER}`, "local:Grid-Demo-A", `syphon:${OWN_SENDER}`];

/** Thrown when the page reloaded (Vite dep optimization, navigation) mid-scenario. */
export class PageReloadedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageReloadedError";
  }
}

type LitSample = { width: number; height: number; lit: number };
type DeckReading = { status: string; arrival: number; draw: number; lit: number };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Count sampled pixels that are visible (rgb > 0 and alpha > 0) in a 2D canvas.
const litPixelsExpr = (selector: string): string => `(() => {
  const c = document.querySelector(${JSON.stringify(selector)});
  if (!(c instanceof HTMLCanvasElement)) return { width: 0, height: 0, lit: -1 };
  const ctx = c.getContext("2d");
  if (!ctx || c.width === 0 || c.height === 0) return { width: c.width, height: c.height, lit: 0 };
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let lit = 0;
  for (let i = 0; i < data.length; i += 4 * 97) {
    if (data[i] + data[i + 1] + data[i + 2] > 0 && data[i + 3] > 0) lit++;
  }
  return { width: c.width, height: c.height, lit };
})()`;

const optionValuesExpr = (selectID: string): string =>
  `[...document.getElementById(${JSON.stringify(selectID)}).options].map((o) => o.value).filter(Boolean)`;

const selectAndClickExpr = (selectID: string, value: string, buttonID: string): string => `(() => {
  const s = document.getElementById(${JSON.stringify(selectID)});
  s.value = ${JSON.stringify(value)};
  s.dispatchEvent(new Event("change"));
  document.getElementById(${JSON.stringify(buttonID)}).click();
})()`;

const clickExpr = (id: string): string => `document.getElementById(${JSON.stringify(id)}).click()`;
const textExpr = (id: string): string =>
  `document.getElementById(${JSON.stringify(id)}).textContent ?? ""`;

const parseFps = (text: string, label: string): number => {
  const match = new RegExp(`${label} ([\\d.]+) fps`).exec(text);
  return match?.[1] === undefined ? -1 : parseFloat(match[1]);
};

/** Guard: abort the scenario if the page reloaded since `baseline`. */
const assertNoReload = (session: CDPSession, baseline: number): void => {
  if (session.isClosed() || session.loadCount() !== baseline) {
    throw new PageReloadedError("page reloaded during scenario");
  }
};

/** Poll `read` until `done` or timeout; returns the last reading. */
const pollUntil = async <T extends unknown>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  const first = await read();
  if (done(first)) return first;
  let last = first;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    last = await read();
    if (done(last)) return last;
  }
  return last;
};

/** Click Refresh until every wanted option is listed (own Syphon server may announce late). */
const waitForOptions = async (
  session: CDPSession,
  selectID: string,
  wanted: string[],
  timeoutMs: number,
): Promise<string[]> => {
  const read = async (): Promise<string[]> => {
    await session.evaluate(clickExpr("refreshBtn"));
    await sleep(300);
    return session.evaluate<string[]>(optionValuesExpr(selectID));
  };
  return pollUntil(read, (opts) => wanted.every((w) => opts.includes(w)), timeoutMs, 1000);
};

const readDeck = async (session: CDPSession, slot: number): Promise<DeckReading> => {
  const status = await session.evaluate<string>(textExpr(`status-${slot}`));
  const sample = await session.evaluate<LitSample>(litPixelsExpr(`#deck-${slot}`));
  return {
    status,
    arrival: parseFps(status, "arrival"),
    draw: parseFps(status, "draw"),
    lit: sample.lit,
  };
};

const deckHealthy = (reading: DeckReading, t: Thresholds): boolean =>
  reading.status.includes("connected:") &&
  reading.arrival > t.minFps &&
  reading.draw > t.minFps &&
  reading.lit > t.minLit;

const readAllDecks = async (session: CDPSession, count: number): Promise<DeckReading[]> => {
  const readings: DeckReading[] = [];
  for (const slot of Array.from({ length: count }, (_, i) => i))
    readings.push(await readDeck(session, slot));
  return readings;
};

const deckCheck = (slot: number, source: string, reading: DeckReading, t: Thresholds): Check => ({
  name: `multiviewer deck ${slot} (${source})`,
  pass: deckHealthy(reading, t),
  detail: `arrival=${reading.arrival} draw=${reading.draw} lit=${reading.lit} | "${reading.status}"`,
});

export const runMultiviewer = async (session: CDPSession, t: Thresholds): Promise<Check[]> => {
  const baseline = session.loadCount();
  const options = await waitForOptions(session, "source-0", MULTIVIEWER_PLAN, 20_000);
  assertNoReload(session, baseline);
  const missing = MULTIVIEWER_PLAN.filter((v) => !options.includes(v));
  if (missing.length > 0) {
    return [
      {
        name: "multiviewer sources listed",
        pass: false,
        detail: `missing ${missing.join(", ")}; got ${options.join(", ")}`,
      },
    ];
  }

  for (const [slot, value] of MULTIVIEWER_PLAN.entries()) {
    await session.evaluate(selectAndClickExpr(`source-${slot}`, value, `connect-${slot}`));
  }

  const readings = await pollUntil(
    () => readAllDecks(session, MULTIVIEWER_PLAN.length),
    (all) => all.every((r) => deckHealthy(r, t)),
    15_000,
  );
  assertNoReload(session, baseline);
  const deckChecks = readings.map((reading, slot) =>
    deckCheck(slot, MULTIVIEWER_PLAN[slot] ?? "?", reading, t),
  );

  const deck0WasLit = readings[0] !== undefined && deckHealthy(readings[0], t);
  await session.evaluate(clickExpr("disconnect-0"));
  const afterDisconnect = await pollUntil(
    () => readDeck(session, 0),
    (r) => r.status.includes("disconnected") && r.lit === 0,
    5_000,
  );
  assertNoReload(session, baseline);

  for (const slot of MULTIVIEWER_PLAN.keys()) {
    if (slot === 0) continue;
    await session.evaluate(clickExpr(`disconnect-${slot}`));
  }

  return [
    { name: "multiviewer sources listed", pass: true, detail: MULTIVIEWER_PLAN.join(", ") },
    ...deckChecks,
    {
      name: "multiviewer deck 0 disconnect clears",
      // Only meaningful if deck 0 was actually lit before the disconnect.
      pass:
        deck0WasLit && afterDisconnect.status.includes("disconnected") && afterDisconnect.lit === 0,
      detail: deck0WasLit
        ? `lit=${afterDisconnect.lit} | "${afterDisconnect.status}"`
        : `not verifiable: deck 0 was not healthy before disconnect | "${afterDisconnect.status}"`,
    },
  ];
};

type ReceiverReading = { info: string; renderFps: number; lit: number };

const readReceiver = async (session: CDPSession): Promise<ReceiverReading> => {
  const info = await session.evaluate<string>(textExpr("info"));
  const sample = await session.evaluate<LitSample>(litPixelsExpr("#canvas"));
  return { info, renderFps: parseFps(info, "render"), lit: sample.lit };
};

export const runReceiver = async (session: CDPSession, t: Thresholds): Promise<Check[]> => {
  const baseline = session.loadCount();
  const senders = await waitForOptions(session, "senderList", [OWN_SENDER], 20_000);
  assertNoReload(session, baseline);
  if (!senders.includes(OWN_SENDER)) {
    return [
      {
        name: "receiver sender listed",
        pass: false,
        detail: `missing ${OWN_SENDER}; got ${senders.join(", ")}`,
      },
    ];
  }

  await session.evaluate(selectAndClickExpr("senderList", OWN_SENDER, "connectBtn"));
  await pollUntil(
    () => readReceiver(session),
    (r) => r.renderFps > t.minFps && r.lit > t.minLit,
    15_000,
  );
  // The first render-fps window is measured from page load (lastFpsTime = 0),
  // so it under-reports badly; wait one more full window before judging.
  await sleep(RECEIVER_FPS_WINDOW_MS);
  const reading = await readReceiver(session);
  assertNoReload(session, baseline);
  await session.evaluate(clickExpr("disconnectBtn"));

  return [
    { name: "receiver sender listed", pass: true, detail: OWN_SENDER },
    {
      name: `receiver (${OWN_SENDER})`,
      pass: reading.renderFps > t.minFps && reading.lit > t.minLit,
      detail: `render=${reading.renderFps} lit=${reading.lit} | "${reading.info}"`,
    },
  ];
};
