// Hot-path micro benchmark for the zero-copy receive/send path (macOS / Syphon).
//
// Run from the repo root after `pnpm build:native` (Electron main process, no windows):
//
//   MODE=poll W=1920 H=1080 packages/example/node_modules/.bin/electron packages/native/bench/hot-path.mjs
//   MODE=push W=3840 H=2160 packages/example/node_modules/.bin/electron packages/native/bench/hot-path.mjs
//
// Env: MODE=poll|push (default poll), W/H (default 1920x1080), FLIP=0 to disable the
// receive-side Y flip, N = measured frames (poll default 600, push default 300).
//
// poll: main thread drives a TextureSender (RGBA upload, only to generate frames) ->
//       TextureReceiver.receiveSharedTexture() -> second TextureSender.sendSurface()
//       -> closeNativeHandle(). Reports main-thread blocking time of each call.
// push: a worker_threads producer (producer-worker.cjs) publishes at ~60 Hz;
//       TextureReceiver.onSharedTexture() delivers frames. Reports time spent inside
//       the JS callback and publish -> callback latency (wall clock shared through a
//       SharedArrayBuffer), then checks stop() while frames are still flowing.
//
// Headless caveat: with no BrowserWindow open, Electron's main runloop only wakes on
// native events, so timer-driven latencies here are not representative of a busy app.
// Always kill Electron afterwards if a run is interrupted: `pkill -f hot-path.mjs`.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { app, powerSaveBlocker } = require("electron");
const { Worker } = require("node:worker_threads");
const native = require("../index.js");

const { TextureSender, TextureReceiver, listSenders, closeNativeHandle } = native;

const MODE = process.env.MODE ?? "poll";
const W = parseInt(process.env.W ?? "1920", 10);
const H = parseInt(process.env.H ?? "1080", 10);
const FLIP = process.env.FLIP !== "0";
const WARMUP = 30;

setTimeout(() => {
  console.error("watchdog timeout");
  app.exit(2);
}, 90_000).unref?.();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

const stats = (xs) => {
  if (xs.length === 0) return "n=0";
  const s = [...xs].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return `n=${s.length} mean=${mean.toFixed(3)} p50=${p(0.5).toFixed(3)} p95=${p(0.95).toFixed(3)} p99=${p(0.99).toFixed(3)} max=${s[s.length - 1].toFixed(3)} ms`;
};

const connect = async (name) => {
  for (let i = 0; i < 200; i++) {
    await sleep(25);
    if (listSenders().some((s) => s.name === name)) {
      const recv = new TextureReceiver(name);
      recv.setFlipY(FLIP);
      return recv;
    }
  }
  throw new Error(`server "${name}" not discovered`);
};

const runPoll = async () => {
  const n = parseInt(process.env.N ?? "600", 10);
  const name = `bench-src-${process.pid}`;
  const src = new TextureSender(name, W, H);
  const out = new TextureSender(`bench-out-${process.pid}`, W, H);
  const buf = Buffer.alloc(W * H * 4, 0x80);
  src.sendRgbaBuffer(buf, W, H);
  const recv = await connect(name);

  const tRecv = [];
  const tSend = [];
  const tLoop = [];
  let misses = 0;
  for (let i = 0; i < n + WARMUP; i++) {
    buf[0] = i & 0xff;
    src.sendRgbaBuffer(buf, W, H);
    const deadline = now() + 100;
    while (!recv.hasNewFrame() && now() < deadline) await sleep(0);
    const t0 = now();
    const frame = recv.receiveSharedTexture();
    const t1 = now();
    if (!frame) {
      misses++;
      continue;
    }
    out.sendSurface(frame.handle, frame.width, frame.height);
    const t2 = now();
    closeNativeHandle(frame.handle);
    if (i >= WARMUP) {
      tRecv.push(t1 - t0);
      tSend.push(t2 - t1);
      tLoop.push(t2 - t0);
    }
    await sleep(0);
  }
  console.log(`RESULT mode=poll ${W}x${H} flipY=${FLIP} frames=${tRecv.length} misses=${misses}`);
  console.log(`  receiveSharedTexture: ${stats(tRecv)}`);
  console.log(`  sendSurface:          ${stats(tSend)}`);
  console.log(`  recv+send (JS block): ${stats(tLoop)}`);
  recv.stop();
  src.stop();
  out.stop();
  return 0;
};

const runPush = async () => {
  const n = parseInt(process.env.N ?? "300", 10);
  const name = `bench-push-${process.pid}`;
  // Float64 layout: [0]=last publish wall-clock ms, [1]=published count, [2]=W, [3]=H
  const sab = new SharedArrayBuffer(32);
  const ts = new Float64Array(sab);
  ts[2] = W;
  ts[3] = H;
  const worker = new Worker(new URL("./producer-worker.cjs", import.meta.url), {
    workerData: { name, sab, nativePath: require.resolve("../index.js") },
  });
  const recv = await connect(name);
  const out = new TextureSender(`bench-push-out-${process.pid}`, W, H);

  const inCb = [];
  const lat = [];
  let received = 0;
  let afterStop = 0;
  let stopped = false;
  let badShape = 0;
  recv.onSharedTexture((frame) => {
    const t0 = now();
    if (stopped) afterStop++;
    received++;
    if (frame.ownerPid !== process.pid || frame.handle.length !== 8) badShape++;
    out.sendSurface(frame.handle, frame.width, frame.height);
    closeNativeHandle(frame.handle);
    if (received > WARMUP) {
      inCb.push(now() - t0);
      lat.push(performance.timeOrigin + t0 - ts[0]);
    }
  });
  const publishedAtStart = ts[1];
  while (received < n + WARMUP) await sleep(10);

  const tStop = now();
  recv.stop();
  const stopMs = now() - tStop;
  stopped = true;
  const published = ts[1] - publishedAtStart;
  await sleep(500);
  let threw = "";
  try {
    recv.onSharedTexture(() => {});
  } catch (e) {
    threw = e.message;
  }
  await worker.terminate();
  out.stop();

  console.log(`RESULT mode=push ${W}x${H} flipY=${FLIP} received=${received} published~=${published} badShape=${badShape}`);
  console.log(`  time inside callback (sendSurface+close): ${stats(inCb)}`);
  console.log(`  publish->callback latency:                ${stats(lat)}`);
  console.log(`  stop() took ${stopMs.toFixed(3)} ms; callbacks after stop=${afterStop}; onSharedTexture after stop threw="${threw}"`);
  const ok = afterStop === 0 && badShape === 0 && threw === "TextureReceiver has been stopped";
  return ok ? 0 : 3;
};

const main = async () => {
  powerSaveBlocker.start("prevent-app-suspension");
  app.dock?.hide();
  const code = MODE === "push" ? await runPush() : await runPoll();
  app.exit(code);
};

// Electron ESM main: never top-level-await app.whenReady().
app
  .whenReady()
  .then(main)
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
