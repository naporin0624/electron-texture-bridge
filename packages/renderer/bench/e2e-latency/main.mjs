// End-to-end latency bench: Syphon publish -> main push callback -> importSharedTexture ->
// sendSharedTexture -> renderer onFrame -> draw (macOS / Syphon, Electron 40).
//
// Prerequisites (from the repo root): native addon built (`pnpm build:native`, or the
// prebuilt packages/native/index.darwin-arm64.node + index.js), and
// `pnpm --filter @napolab/texture-bridge-core build && pnpm --filter @napolab/texture-bridge-renderer build`
// (preload requires packages/renderer/dist/client, PIPE=B requires packages/renderer/dist).
//
// Run one configuration (from the repo root; a visible window opens):
//
//   PIPE=A DRAW=2d W=1920 H=1080 N=1 packages/example/node_modules/.bin/electron packages/renderer/bench/e2e-latency/main.mjs
//
// Run the whole matrix and summarize:
//
//   node packages/renderer/bench/e2e-latency/run-matrix.mjs results.jsonl
//   node packages/renderer/bench/e2e-latency/summarize.mjs results.jsonl
//
// Env:
//   PIPE     A = instrumented replica of createSharedTextureReceiver push mode (per-stage stamps)
//            B = real createSharedTextureReceiver({ mode: "push" }) from packages/renderer/dist,
//                one receiver per slot = N native receivers on the same source (total only)
//            F = fan-out: ONE createSharedTextureReceiver({ mode: "push", target }) for slot 0
//                plus N-1 receiver.forwardFrames(target, { extraArgs: [slot, -1] }) — one native
//                receive + one import per frame, per-target latest-wins (total only)
//                                                                                  default A
//   DRAW     2d | 2d-immediate | webgpu | none                                            default 2d
//   W, H     producer frame size                                                   default 1920x1080
//   N        receivers on the same Syphon source (one canvas each)                 default 1
//   WINDOWS  1 = one BrowserWindow per receiver, 0 = all canvases in one window    default 0
//   CANVAS_W, CANVAS_H  canvas backing size per receiver                           default 480x270
//   WARMUP   published frames ignored before recording                            default 60
//   FRAMES   published frames recorded                                             default 360
//   FPS      producer rate                                                         default 60
//
// Prints one line `RESULT {json}` and exits. Always kill Electron afterwards if a run is
// interrupted: kill the run's process group (`kill -9 -<pid of the electron launcher>`;
// run-matrix.mjs does this after every run). Avoid a broad pkill that can hit other apps.
//
// Caveats:
// - Seq approximation (PIPE=A): the native callback carries no frame id, so the callback is
//   attributed to the seq the producer most recently STARTED publishing (Atomics counter read in
//   the callback). If a callback for frame k arrives after frame k+1 started, it is misattributed
//   (latency under-reported by one period). At 60 Hz with ~2 ms latency this is rare.
// - PIPE=B/F cannot carry a seq (extraArgs is fixed per receiver): each renderer arrival is matched
//   to the latest publish that completed before it ("latest-pub" match). A totals are reported
//   with both methods so A and B can be compared like for like.
// - All stamps are `performance.timeOrigin + performance.now()` in each thread/process. A main <->
//   renderer ping-pong at startup estimates the clock offset (reported, not applied).
// - The window must be visible for rAF to run; numbers include the real compositor.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, powerSaveBlocker, sharedTexture } = require("electron");
const { Worker } = require("node:worker_threads");
const { monitorEventLoopDelay } = require("node:perf_hooks");

const here = path.dirname(fileURLToPath(import.meta.url));
const nativePath = path.resolve(here, "../../../native/index.js");
const native = require(nativePath);
const { TextureReceiver, listSenders, closeNativeHandle } = native;

const env = (k, d) => process.env[k] ?? d;
const PIPE = env("PIPE", "A");
const DRAW = env("DRAW", "2d");
const W = parseInt(env("W", "1920"), 10);
const H = parseInt(env("H", "1080"), 10);
const N = parseInt(env("N", "1"), 10);
const WINDOWS = env("WINDOWS", "0") === "1";
const CANVAS_W = parseInt(env("CANVAS_W", "480"), 10);
const CANVAS_H = parseInt(env("CANVAS_H", "270"), 10);
const WARMUP = parseInt(env("WARMUP", "60"), 10);
const FRAMES = parseInt(env("FRAMES", "360"), 10);
const FPS = parseFloat(env("FPS", "60"));
const RING = 4096;

setTimeout(() => {
  console.error("watchdog timeout");
  app.exit(2);
}, 120_000).unref?.();

const wall = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- stats helpers
const summarize = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length === 0) return { n: 0 };
  const s = [...v].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const r = (x) => Math.round(x * 1000) / 1000;
  return {
    n: s.length,
    min: r(s[0]),
    mean: r(mean),
    p50: r(p(0.5)),
    p95: r(p(0.95)),
    p99: r(p(0.99)),
    max: r(s[s.length - 1]),
  };
};

// ---------------------------------------------------------------- producer
const ctrSab = new SharedArrayBuffer(8);
const ctr = new Int32Array(ctrSab);
const timesSab = new SharedArrayBuffer(RING * 2 * 8);
const times = new Float64Array(timesSab);
const pubStart = (seq) => times[seq % RING];
const pubEnd = (seq) => times[RING + (seq % RING)];
const completedSeq = () => Atomics.load(ctr, 0);
const publishingSeq = () => Atomics.load(ctr, 1);

/** Latest seq whose publish completed at or before t (searches back from the newest). */
const matchLatestPub = (t) => {
  for (let s = completedSeq(); s > 0 && s > completedSeq() - RING + 2; s--) {
    if (pubEnd(s) <= t) return s;
  }
  return 0;
};

// ---------------------------------------------------------------- windows / renderer IPC
const windows = [];
const rendererInfo = [];
const stamps = [];
const rafDeltas = [];

const createWindow = (slots, index) => {
  const cols = Math.ceil(Math.sqrt(slots.length));
  const cfg = { draw: DRAW, slots, cols, canvasW: CANVAS_W, canvasH: CANVAS_H, index };
  const win = new BrowserWindow({
    width: WINDOWS ? 520 : 1280,
    height: WINDOWS ? 320 : 760,
    x: WINDOWS ? 40 + (index % 4) * 40 : undefined,
    y: WINDOWS ? 40 + (index % 4) * 30 : undefined,
    show: true,
    title: `e2e-latency ${index}`,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
      preload: path.join(here, "preload.cjs"),
      additionalArguments: [`--bench-config=${JSON.stringify(cfg)}`],
    },
  });
  win.loadFile(path.join(here, "index.html"));
  return win;
};

const waitFor = async (pred, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
};

ipcMain.on("bench-ready", (_e, info) => rendererInfo.push(info));
ipcMain.on("bench-stamps", (_e, batch, rafBatch) => {
  for (const s of batch) stamps.push(s);
  for (const d of rafBatch) rafDeltas.push(d);
});

/** NTP-style offset estimate main -> renderer, best of `rounds` by RTT. */
const calibrateClock = async (win, rounds) => {
  const results = [];
  for (let i = 0; i < rounds; i++) {
    const t1 = wall();
    const reply = new Promise((resolve) =>
      ipcMain.once("bench-pong", (_e, t2, t3) => resolve([t2, t3])),
    );
    win.webContents.send("bench-ping");
    const [t2, t3] = await reply;
    const t4 = wall();
    results.push({ rtt: t4 - t1 - (t3 - t2), offset: (t2 - t1 + (t3 - t4)) / 2 });
    await sleep(5);
  }
  results.sort((a, b) => a.rtt - b.rtt);
  return { rttMs: results[0].rtt, offsetMs: results[0].offset };
};

const flushRenderers = async () => {
  const pending = windows.map(
    (win) =>
      new Promise((resolve) => {
        const handler = (e, counters) => {
          if (e.sender !== win.webContents) return;
          ipcMain.removeListener("bench-flushed", handler);
          resolve(counters);
        };
        ipcMain.on("bench-flushed", handler);
        win.webContents.send("bench-flush");
      }),
  );
  return Promise.all(pending);
};

// ---------------------------------------------------------------- record window
const rec = { startSeq: Infinity, endSeq: Infinity, stopped: false };
const seqInWindow = (seq) => seq >= rec.startSeq && seq < rec.endSeq;

// ---------------------------------------------------------------- pipeline A (instrumented replica)
const recordsA = new Map();
let didCounter = 0;

const makeSlotA = (r, wc) => ({
  r,
  wc,
  recv: null,
  inFlight: false,
  pending: null,
  callbacks: 0,
  callbacksInWindow: 0,
  dropMain: 0,
  importErr: 0,
  sendErr: 0,
});

const importFrame = (frame) =>
  sharedTexture.importSharedTexture({
    textureInfo: {
      codedSize: { width: frame.width, height: frame.height },
      handle: { ioSurface: frame.handle },
      pixelFormat: frame.pixelFormat,
    },
  });

/** Mirrors SharedTextureReceiverBridgeImpl._deliverFrame -> _send -> _prepare -> sendImportedTexture. */
const deliverA = async (slot, item) => {
  slot.inFlight = true;
  const r = { r: slot.r, seq: item.seq, tCb: item.tCb, tDeq: wall(), did: ++didCounter };
  let imported = null;
  try {
    imported = importFrame(item.frame);
  } catch {
    slot.importErr++;
  } finally {
    // Electron does not take ownership of the IOSurface retain: close after the import attempt.
    closeNativeHandle(item.frame.handle);
  }
  r.tImp = wall();
  if (imported) {
    try {
      const p = sharedTexture.sendSharedTexture(
        { frame: slot.wc.mainFrame, importedSharedTexture: imported },
        slot.r,
        r.did,
      );
      r.tSend = wall();
      await p;
      r.tAck = wall();
    } catch {
      slot.sendErr++;
    } finally {
      imported.release();
    }
  }
  recordsA.set(r.did, r);
  slot.inFlight = false;
  const next = slot.pending;
  slot.pending = null;
  if (!next) return;
  if (rec.stopped) {
    closeNativeHandle(next.frame.handle);
    return;
  }
  void deliverA(slot, next);
};

const onPushedA = (slot, frame) => {
  const tCb = wall();
  const seq = publishingSeq();
  slot.callbacks++;
  if (seqInWindow(seq)) slot.callbacksInWindow++;
  if (rec.stopped) {
    closeNativeHandle(frame.handle);
    return;
  }
  const item = { frame, tCb, seq };
  if (slot.inFlight) {
    if (slot.pending) {
      closeNativeHandle(slot.pending.frame.handle);
      if (seqInWindow(slot.pending.seq)) slot.dropMain++;
    }
    slot.pending = item;
    return;
  }
  void deliverA(slot, item);
};

const startA = (name, targets) =>
  targets.map((wc, r) => {
    const slot = makeSlotA(r, wc);
    slot.recv = new TextureReceiver(name);
    slot.recv.setFlipY(true);
    slot.recv.onSharedTexture((frame) => onPushedA(slot, frame));
    return slot;
  });

const stopA = (slots) => {
  for (const slot of slots) {
    slot.recv.onSharedTexture(null);
    if (slot.pending) closeNativeHandle(slot.pending.frame.handle);
    slot.pending = null;
  }
};

// ---------------------------------------------------------------- import counter (B / F)
// The real API calls `electron.sharedTexture.importSharedTexture` at call time, so wrapping the
// property counts its imports and stamps them. The stamp is taken on entry to the import, i.e.
// right after the native push callback (+ the bridge's synchronous bookkeeping), so
// `pub -> import` approximates A's `pub -> cb`. Seq is attributed as in A (publishingSeq()).
const importLog = [];
const instrumentImport = () => {
  const original = sharedTexture.importSharedTexture;
  try {
    sharedTexture.importSharedTexture = (opts) => {
      importLog.push({ t: wall(), seq: publishingSeq() });
      return original.call(sharedTexture, opts);
    };
  } catch {
    return false;
  }
  return sharedTexture.importSharedTexture !== original;
};

// ---------------------------------------------------------------- pipeline B (real API)
const startB = (name, targets) => {
  const { createSharedTextureReceiver } = require(path.resolve(here, "../../dist/index.cjs"));
  return targets.map((wc, r) => {
    const slot = { r, errors: 0, fpsEvents: [], bridge: null };
    slot.bridge = createSharedTextureReceiver({
      senderName: name,
      target: wc,
      mode: "push",
      extraArgs: [r, -1],
    });
    slot.bridge.on("error", () => slot.errors++);
    slot.bridge.on("fps", (fps) => slot.fpsEvents.push(fps));
    slot.bridge.start();
    return slot;
  });
};

const stopB = (slots) => {
  for (const slot of slots) slot.bridge.dispose();
};

// ---------------------------------------------------------------- pipeline F (real API, fan-out)
/** Slot 0 is the receiver's primary `target`; slots 1..N-1 are forwardFrames registrations. */
const startF = (name, targets) => {
  const { createSharedTextureReceiver } = require(path.resolve(here, "../../dist/index.cjs"));
  const [primary, ...rest] = targets;
  const state = { errors: 0, fpsEvents: [], statusFail: {}, forwards: [], bridge: null };
  state.bridge = createSharedTextureReceiver({
    senderName: name,
    target: primary,
    mode: "push",
    extraArgs: [0, -1],
  });
  state.bridge.on("error", () => state.errors++);
  state.bridge.on("fps", (fps) => state.fpsEvents.push(fps));
  const onStatus = (status) => {
    if (status.ok) return;
    state.statusFail[status.reason] = (state.statusFail[status.reason] ?? 0) + 1;
  };
  state.forwards = rest.map((wc, i) =>
    state.bridge.forwardFrames(wc, { extraArgs: [i + 1, -1], onStatus }),
  );
  state.bridge.start();
  return state;
};

const stopF = (state) => {
  state.activeBeforeStop = state.forwards.filter((f) => f.active).length;
  for (const f of state.forwards) f.dispose();
  state.bridge.dispose();
};

// ---------------------------------------------------------------- analysis
const analyze = (ctx) => {
  const { tStart, tEnd, slotsA, slotsB, stateF, counters, eld, calib } = ctx;
  const dur = (tEnd - tStart) / 1000;
  const inT = (t) => t >= tStart && t < tEnd;
  const rx = stamps.filter((s) => inT(s.tRx));
  const byDid = new Map(rx.filter((s) => s.did > 0).map((s) => [s.did, s]));
  const delivered = Array.from({ length: N }, () => 0);
  const drawn = Array.from({ length: N }, () => 0);
  for (const s of rx) {
    delivered[s.r]++;
    if (Number.isFinite(s.tDraw) || Number.isFinite(s.tGpu)) drawn[s.r]++;
  }
  const out = {
    config: { PIPE, DRAW, W, H, N, WINDOWS, CANVAS_W, CANVAS_H, WARMUP, FRAMES, FPS },
    publishedFps: FRAMES / dur,
    producerUploadMs: summarize(
      Array.from(
        { length: FRAMES },
        (_, i) => pubEnd(rec.startSeq + i) - pubStart(rec.startSeq + i),
      ),
    ),
    deliveredFps: {
      mean: delivered.reduce((a, b) => a + b, 0) / N / dur,
      min: Math.min(...delivered) / dur,
    },
    drawnFps: { mean: drawn.reduce((a, b) => a + b, 0) / N / dur, min: Math.min(...drawn) / dur },
    dropsPerReceiver: {
      publishedMinusDelivered: FRAMES - delivered.reduce((a, b) => a + b, 0) / N,
    },
    rendererSuperseded: rx.filter((s) => s.superseded).length,
    rendererInWindow: {
      maxDepth: Math.max(0, ...rx.map((s) => s.depth ?? 0)),
      maxLive: Math.max(0, ...rx.map((s) => s.live ?? 0)),
    },
    eventLoopDelayMs: eld,
    clock: calib,
    renderer: { counters, info: rendererInfo },
    rafIntervalMs: summarize(rafDeltas.filter((d) => inT(d.t)).map((d) => d.dt)),
    stages: {},
  };
  const lat = (s) => ({
    rx: s.tRx - pubEnd(matchLatestPub(s.tRx)),
    draw: Number.isFinite(s.tDraw) ? s.tDraw - pubEnd(matchLatestPub(s.tRx)) : NaN,
    gpu: Number.isFinite(s.tGpu) ? s.tGpu - pubEnd(matchLatestPub(s.tRx)) : NaN,
  });
  const matched = rx.map(lat);
  out.stages.totalLatestPub_pub_rx = summarize(matched.map((m) => m.rx));
  out.stages.totalLatestPub_pub_draw = summarize(matched.map((m) => m.draw));
  out.stages.totalLatestPub_pub_gpu = summarize(matched.map((m) => m.gpu));
  out.ambiguousMatches = matched.filter((m) => m.rx > 1000 / FPS).length;
  out.stages.draw_cpu = summarize(rx.map((s) => s.tDraw - (s.tDrawStart ?? s.tRx)));
  out.stages.rx_draw = summarize(rx.map((s) => s.tDraw - s.tRx));
  out.stages.rx_gpuDone = summarize(rx.map((s) => s.tGpu - s.tRx));
  out.stages.submit_gpuDone = summarize(rx.map((s) => s.tGpu - s.tDraw));
  out.stages.rx_raf = summarize(rx.map((s) => s.tRaf - s.tRx));

  if (slotsA) {
    const recs = [...recordsA.values()].filter((r) => seqInWindow(r.seq));
    const joined = recs.map((r) => ({ ...r, ...byDid.get(r.did) }));
    const st = out.stages;
    st.pub_cb = summarize(recs.map((r) => r.tCb - pubEnd(r.seq)));
    st.pubStart_cb = summarize(recs.map((r) => r.tCb - pubStart(r.seq)));
    st.cb_dequeue = summarize(recs.map((r) => r.tDeq - r.tCb));
    st.import = summarize(recs.map((r) => r.tImp - r.tDeq));
    st.sendCall = summarize(recs.map((r) => r.tSend - r.tImp));
    st.send_rx = summarize(joined.map((r) => r.tRx - r.tSend));
    st.send_ack = summarize(recs.map((r) => r.tAck - r.tSend));
    st.ack_minus_rx = summarize(joined.map((r) => r.tAck - r.tRx));
    st.totalSeq_pub_rx = summarize(joined.map((r) => r.tRx - pubEnd(r.seq)));
    st.totalSeq_pub_draw = summarize(joined.map((r) => r.tDraw - pubEnd(r.seq)));
    st.totalSeq_pub_gpu = summarize(joined.map((r) => r.tGpu - pubEnd(r.seq)));
    out.mainA = {
      callbacksPerReceiverFps: slotsA.reduce((a, s) => a + s.callbacksInWindow, 0) / N / dur,
      nativeDropsPerReceiver: FRAMES - slotsA.reduce((a, s) => a + s.callbacksInWindow, 0) / N,
      mainLatestWinsDropsPerReceiver: slotsA.reduce((a, s) => a + s.dropMain, 0) / N,
      importErrors: slotsA.reduce((a, s) => a + s.importErr, 0),
      sendErrors: slotsA.reduce((a, s) => a + s.sendErr, 0),
      deliveriesWithoutRendererStamp: joined.filter((r) => !Number.isFinite(r.tRx)).length,
    };
  }
  if (ctx.importInstrumented) {
    const imps = importLog.filter((i) => seqInWindow(i.seq));
    out.imports = {
      perPublishedFrame: imps.length / FRAMES,
      pub_import: summarize(imps.map((i) => i.t - pubEnd(i.seq))),
    };
  }
  if (slotsB) {
    out.mainB = {
      errors: slotsB.reduce((a, s) => a + s.errors, 0),
      lastFpsEvent: slotsB.map((s) => s.fpsEvents.at(-1) ?? null),
    };
  }
  if (stateF) {
    out.mainF = {
      errors: stateF.errors,
      forwardFailures: stateF.statusFail,
      forwardsActiveAtStop: stateF.activeBeforeStop,
      lastFpsEvent: stateF.fpsEvents.at(-1) ?? null,
    };
  }
  return out;
};

// ---------------------------------------------------------------- main
const main = async () => {
  powerSaveBlocker.start("prevent-app-suspension");
  const slotIds = Array.from({ length: N }, (_, i) => i);
  const groups = WINDOWS ? slotIds.map((i) => [i]) : [slotIds];
  for (const [i, g] of groups.entries()) windows.push(createWindow(g, i));
  await waitFor(() => rendererInfo.length === windows.length, 30_000, "renderer ready");
  if (DRAW === "webgpu" && rendererInfo.some((i) => !i.webgpu)) {
    console.log(
      `RESULT ${JSON.stringify({ config: { PIPE, DRAW, W, H, N, WINDOWS }, error: "webgpu unavailable", rendererInfo })}`,
    );
    return 4;
  }
  const calib = await calibrateClock(windows[0], 30);
  const targetFor = (r) => windows[WINDOWS ? r : 0].webContents;
  const targets = slotIds.map(targetFor);

  const name = `e2e-bench-${process.pid}`;
  const worker = new Worker(path.join(here, "producer-worker.cjs"), {
    workerData: { name, W, H, RING, intervalMs: 1000 / FPS, ctrSab, timesSab, nativePath },
  });
  await waitFor(() => listSenders().some((s) => s.name === name), 10_000, "sender discovery");

  const slotsA = PIPE === "A" ? startA(name, targets) : null;
  const importInstrumented = PIPE === "B" || PIPE === "F" ? instrumentImport() : false;
  const slotsB = PIPE === "B" ? startB(name, targets) : null;
  const stateF = PIPE === "F" ? startF(name, targets) : null;

  const s0 = completedSeq();
  await waitFor(() => completedSeq() >= s0 + WARMUP, 30_000, "warmup");
  rec.startSeq = completedSeq() + 1;
  rec.endSeq = rec.startSeq + FRAMES;
  const eld = monitorEventLoopDelay({ resolution: 1 });
  await waitFor(() => completedSeq() >= rec.startSeq, 1000, "record start");
  eld.enable();
  await waitFor(() => completedSeq() >= rec.endSeq, 60_000, "record end");
  eld.disable();
  const tStart = pubEnd(rec.startSeq);
  const tEnd = pubEnd(rec.endSeq);
  await sleep(300); // let in-flight frames land
  rec.stopped = true;
  if (slotsA) stopA(slotsA);
  if (slotsB) stopB(slotsB);
  if (stateF) stopF(stateF);
  await worker.terminate();
  await sleep(100);
  const counters = await flushRenderers();
  const ms = (ns) => Math.round((ns / 1e6) * 1000) / 1000;
  const eldOut = {
    mean: ms(eld.mean),
    p50: ms(eld.percentile(50)),
    p99: ms(eld.percentile(99)),
    max: ms(eld.max),
  };
  const result = analyze({
    tStart,
    tEnd,
    slotsA,
    slotsB,
    stateF,
    importInstrumented,
    counters,
    eld: eldOut,
    calib,
  });
  console.log(`RESULT ${JSON.stringify(result)}`);
  return 0;
};

// Electron ESM main: never top-level-await app.whenReady().
app
  .whenReady()
  .then(main)
  .then((code) => app.exit(code))
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
