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

/**
 * rAF ticks in one second + visibilityState. An occluded/hidden window on
 * macOS reports "hidden" and runs no rAF unless background throttling is
 * disabled for it, so the multiviewer's rAF draw loop would stall
 * (arrival > 0 but draw = 0).
 */
export const RAF_PROBE = `new Promise((resolve) => {
  let n = 0;
  const tick = () => { n++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setTimeout(() => resolve({ state: document.visibilityState, raf: n }), 1000);
})`;

// Covering window: a plain opaque popup spanning the whole available area of
// the display the page is on, so macOS treats the page's window as occluded
// (fully covered). Opened from the page itself so no main-process hook is
// needed; the handle is kept on window.__e2eCover so it can be closed.
const OPEN_COVER_EXPR = `(() => {
  const s = window.screen;
  const features = "left=" + s.availLeft + ",top=" + s.availTop +
    ",width=" + s.availWidth + ",height=" + s.availHeight;
  window.__e2eCover = window.open("about:blank", "e2e-cover", features);
  return window.__e2eCover !== null;
})()`;
const CLOSE_COVER_EXPR = `(() => {
  window.__e2eCover?.close();
  window.__e2eCover = undefined;
})()`;
const COVER_SETTLE_MS = 2500;
const DRAW_COUNT_WINDOW_MS = 1000;

type LitSample = { width: number; height: number; lit: number };
type CoveredProbe = { state: string; raf: number };
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

// Count ctx.drawImage calls on a canvas over a window, by shadowing the
// method on that context instance (the page's draw code holds the same
// context object, since getContext("2d") returns it again).
const drawCountExpr = (selector: string, windowMs: number): string => `new Promise((resolve) => {
  const c = document.querySelector(${JSON.stringify(selector)});
  const ctx = c instanceof HTMLCanvasElement ? c.getContext("2d") : null;
  if (!ctx) { resolve(-1); return; }
  let n = 0;
  const original = ctx.drawImage;
  ctx.drawImage = (...args) => { n++; return original.apply(ctx, args); };
  setTimeout(() => { delete ctx.drawImage; resolve(n); }, ${windowMs});
})`;

type Covered<T> = { opened: boolean; probe: CoveredProbe; reading: T };

/** Open a full-display window over the page, let it settle, read, always close it. */
const whileCovered = async <T extends unknown>(
  session: CDPSession,
  read: () => Promise<T>,
): Promise<Covered<T>> => {
  const opened = await session.evaluate<boolean>(OPEN_COVER_EXPR);
  try {
    await sleep(COVER_SETTLE_MS);
    const probe = await session.evaluate<CoveredProbe>(RAF_PROBE);
    const reading = await read();
    return { opened, probe, reading };
  } finally {
    await session.evaluate(CLOSE_COVER_EXPR).catch(() => undefined);
  }
};

const coveredVisibleCheck = (label: string, covered: Covered<unknown>): Check => ({
  name: `${label} covered: still visible (rAF running)`,
  pass: covered.opened && covered.probe.state === "visible" && covered.probe.raf > 0,
  detail: `cover opened=${covered.opened} visibilityState=${covered.probe.state} rAF/s=${covered.probe.raf}`,
});

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

  // With all decks drawing, cover the window and require the rAF draw loop to
  // keep drawing every deck. readAllDecks reads the 1s draw-fps window, which
  // by then lies entirely inside the covered period.
  const covered = await whileCovered(session, () =>
    readAllDecks(session, MULTIVIEWER_PLAN.length),
  );
  assertNoReload(session, baseline);
  const coveredChecks: Check[] = [
    coveredVisibleCheck("multiviewer", covered),
    ...covered.reading.map((reading, slot) => ({
      name: `multiviewer covered: deck ${slot} still drawing`,
      pass: reading.draw > t.minFps,
      detail: `arrival=${reading.arrival} draw=${reading.draw} | "${reading.status}"`,
    })),
  ];

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
    ...coveredChecks,
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
  // The receiver draws from onFrame (not rAF), so count actual drawImage calls
  // while covered rather than trusting the last render-fps text. Note: unlike
  // the multiviewer, this window was not observed to report "hidden" under the
  // cover even without backgroundThrottling:false, so this step guards against
  // regressions but does not by itself prove the receiver's opt-out.
  const covered = await whileCovered(session, () =>
    session.evaluate<number>(drawCountExpr("#canvas", DRAW_COUNT_WINDOW_MS)),
  );
  assertNoReload(session, baseline);
  await session.evaluate(clickExpr("disconnectBtn"));

  return [
    { name: "receiver sender listed", pass: true, detail: OWN_SENDER },
    {
      name: `receiver (${OWN_SENDER})`,
      pass: reading.renderFps > t.minFps && reading.lit > t.minLit,
      detail: `render=${reading.renderFps} lit=${reading.lit} | "${reading.info}"`,
    },
    coveredVisibleCheck("receiver", covered),
    {
      name: "receiver covered: still drawing",
      pass: covered.reading > t.minFps,
      detail: `drawImage calls in ${DRAW_COUNT_WINDOW_MS}ms=${covered.reading}`,
    },
  ];
};
