// Frame producer for hot-path.mjs (MODE=push). Runs in a worker_threads worker so
// the CPU upload that generates frames stays off the main thread under test.
// SharedArrayBuffer (Float64): [0]=last publish wall-clock ms, [1]=published count, [2]=W, [3]=H
const { workerData } = require("node:worker_threads");

const { TextureSender } = require(workerData.nativePath);
const ts = new Float64Array(workerData.sab);
const src = new TextureSender(workerData.name, ts[2], ts[3]);
const buf = Buffer.alloc(ts[2] * ts[3] * 4, 0x40);

setInterval(() => {
  src.sendRgbaBuffer(buf, ts[2], ts[3]);
  ts[0] = performance.timeOrigin + performance.now();
  ts[1] += 1;
}, 16.7);
