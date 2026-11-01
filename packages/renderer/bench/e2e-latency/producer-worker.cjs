// Frame producer for e2e-latency/main.mjs. Copied from packages/native/bench/producer-worker.cjs
// and extended with a per-seq publish-time ring so every stage can be keyed by frame seq.
// Runs in a worker_threads worker so the CPU upload that generates frames stays off the
// main thread under test.
//
// Shared memory:
//   ctr  (Int32Array): [0] = seq of the last COMPLETED publish, [1] = seq currently publishing
//   times (Float64Array, 2 * RING): [seq % RING] = wall-clock ms right before sendRgbaBuffer,
//                                   [RING + seq % RING] = wall-clock ms right after it returns
// Ordering: times are written BEFORE the matching counter store, so a reader that loads the
// counter first then the slot always sees a filled slot for completed seqs.
const { workerData } = require("node:worker_threads");

const { TextureSender } = require(workerData.nativePath);
const { name, W, H, RING, intervalMs } = workerData;
const ctr = new Int32Array(workerData.ctrSab);
const times = new Float64Array(workerData.timesSab);
const src = new TextureSender(name, W, H);
const buf = Buffer.alloc(W * H * 4, 0x40);
const wall = () => performance.timeOrigin + performance.now();

let seq = 0;
setInterval(() => {
  seq += 1;
  buf[0] = seq & 0xff;
  times[seq % RING] = wall();
  Atomics.store(ctr, 1, seq);
  src.sendRgbaBuffer(buf, W, H);
  times[RING + (seq % RING)] = wall();
  Atomics.store(ctr, 0, seq);
}, intervalMs);
