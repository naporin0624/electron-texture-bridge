// Regression check for the preview tap's ThreadsafeFunction teardown (macOS).
//
// Run from the repo root after `pnpm build:native` (plain Node, no Electron):
//
//   node --expose-gc packages/native/bench/preview-detach.cjs
//
// Replacing or removing the tap while preview frames are still queued for the
// JS thread must (a) never call the old callback again and (b) free those
// frames. The tap used to `abort` its TSFN: Node then hands the leftover queue
// to napi-rs's `call_js_cb` with a null env, which returns without freeing the
// payload — ~1 GB leaked over the 60 cycles below (two 8 MB frames each).
// Exits 1 on a late callback or RSS growth past LEAK_LIMIT_MB.
const { TextureSender } = require("../index.js");

const W = 1920;
const H = 1080;
const CYCLES = 60;
const LEAK_LIMIT_MB = 200;

const frame = Buffer.alloc(W * H * 4, 0x80);
const sab = new Int32Array(new SharedArrayBuffer(4));
// Block the JS thread so Metal completion threads queue previews meanwhile.
const blockJs = (ms) => Atomics.wait(sab, 0, 0, ms);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rssMB = () => Math.round(process.memoryUsage().rss / 1e6);

const main = async () => {
  const sender = new TextureSender("etb-preview-detach-check", W, H);
  const failures = [];

  // Swap a -> b with frames queued for a.
  const swap = { replaced: false, lateA: 0, badB: 0 };
  sender.setPreview(W, H, () => {
    if (swap.replaced) swap.lateA++;
  });
  sender.sendRgbaBuffer(frame, W, H);
  sender.sendRgbaBuffer(frame, W, H);
  blockJs(100);
  sender.setPreview(W, H, (f) => {
    if (!f) swap.badB++;
  });
  swap.replaced = true;
  await sleep(200);
  if (swap.lateA > 0) failures.push(`old callback ran ${swap.lateA}x after the swap`);
  if (swap.badB > 0) failures.push(`new callback got ${swap.badB} empty call(s)`);

  // Remove the tap with frames queued, repeatedly.
  const detach = { removed: false, late: 0 };
  const before = rssMB();
  for (let i = 0; i < CYCLES; i++) {
    detach.removed = false;
    sender.setPreview(W, H, () => {
      if (detach.removed) detach.late++;
    });
    sender.sendRgbaBuffer(frame, W, H);
    sender.sendRgbaBuffer(frame, W, H);
    blockJs(60);
    sender.setPreview(0, 0, null);
    detach.removed = true;
    await sleep(5);
  }
  await sleep(300);
  globalThis.gc?.();
  const growth = rssMB() - before;
  if (detach.late > 0) failures.push(`removed callback ran ${detach.late}x`);
  if (growth > LEAK_LIMIT_MB) failures.push(`RSS grew ${growth} MB over ${CYCLES} cycles`);

  sender.stop();
  console.log(`swap: lateA=${swap.lateA}; detach: late=${detach.late}, rss growth=${growth} MB`);
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log("OK");
  }
};

void main();
