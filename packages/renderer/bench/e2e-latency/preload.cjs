// Renderer side of e2e-latency/main.mjs. Runs as a preload with nodeIntegration +
// contextIsolation: false (like packages/example multiviewer), so it can require the built
// client from packages/renderer/dist/client.
//
// One bindSharedTextureReceiver(sharedTexture).consume() registration routes by slot (args[0]) — like multiviewer.ts — so
// each delivered texture creates exactly one VideoFrame. Stamps are batched and flushed to
// main every 500 ms (and on "bench-flush") to keep stamp IPC off the measured path.
//
// DRAW=2d           clone + hold latest VideoFrame per slot, drawImage every rAF (multiviewer)
// DRAW=2d-immediate drawImage inside onFrame
// DRAW=none         stamp arrival only (isolates transport from draw cost)
// DRAW=webgpu       importExternalTexture + fullscreen pass inside onFrame, then await
//                   queue.onSubmittedWorkDone() for a GPU-completion stamp
const path = require("node:path");
const { ipcRenderer, sharedTexture } = require("electron");
const client = require(path.resolve(__dirname, "../../dist/client/index.cjs"));

const cfgArg = process.argv.find((a) => a.startsWith("--bench-config="));
const cfg = JSON.parse(cfgArg.slice("--bench-config=".length));
const wall = () => performance.timeOrigin + performance.now();

const slots = new Map(); // global slot id -> { canvas, ctx, gpuCtx, held }
let stampBatch = [];
let rafBatch = [];
const counters = {
  depth: 0,
  maxDepth: 0,
  live: 0,
  maxLive: 0,
  errors: 0,
  superseded: 0,
  timerResMs: 0,
};

const liveInc = () => {
  counters.live++;
  counters.maxLive = Math.max(counters.maxLive, counters.live);
};

const flush = () => {
  if (stampBatch.length === 0 && rafBatch.length === 0) return;
  ipcRenderer.send("bench-stamps", stampBatch, rafBatch);
  stampBatch = [];
  rafBatch = [];
};

const probeTimerResolution = () => {
  let min = Infinity;
  let prev = performance.now();
  for (let i = 0; i < 200000; i++) {
    const t = performance.now();
    if (t > prev) min = Math.min(min, t - prev);
    prev = t;
  }
  return min;
};

// ---------------------------------------------------------------- WebGPU
let gpu = null;
const WGSL = `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_external;
struct VO { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO;
  o.p = vec4f(pos[i], 0.0, 1.0);
  o.uv = pos[i] * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
  return o;
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(tex, samp, v.uv);
}`;

const initWebGPU = async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  const module = device.createShaderModule({ code: WGSL });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  return {
    device,
    format,
    pipeline,
    sampler,
    adapterInfo: adapter.info?.description ?? adapter.info?.vendor ?? "",
  };
};

const drawWebGPU = async (slot, videoFrame, stamp) => {
  const { device, pipeline, sampler } = gpu;
  stamp.tDrawStart = wall();
  const external = device.importExternalTexture({ source: videoFrame });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: external },
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: slot.gpuCtx.getCurrentTexture().createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: [0, 0, 0, 1],
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  stamp.tDraw = wall();
  await device.queue.onSubmittedWorkDone();
  stamp.tGpu = wall();
};

// ---------------------------------------------------------------- 2d
const drawHeld = (slot, tRaf) => {
  const held = slot.held;
  if (!held) return;
  const t0 = wall();
  slot.ctx.drawImage(held.videoFrame, 0, 0, cfg.canvasW, cfg.canvasH);
  if (held.stamp.tDraw !== undefined) return;
  held.stamp.tRaf = tRaf;
  held.stamp.tDrawStart = t0;
  held.stamp.tDraw = wall();
  stampBatch.push(held.stamp);
};

let lastRaf = 0;
const rafLoop = () => {
  const tRaf = wall();
  if (lastRaf) rafBatch.push({ t: tRaf, dt: tRaf - lastRaf });
  lastRaf = tRaf;
  try {
    for (const slot of slots.values()) drawHeld(slot, tRaf);
  } finally {
    requestAnimationFrame(rafLoop);
  }
};

const holdFrame = (slot, videoFrame, stamp) => {
  const cloned = videoFrame.clone();
  liveInc();
  const prev = slot.held;
  slot.held = { videoFrame: cloned, stamp };
  if (!prev) return;
  prev.videoFrame.close();
  counters.live--;
  if (prev.stamp.tDraw !== undefined) return;
  prev.stamp.superseded = true;
  counters.superseded++;
  stampBatch.push(prev.stamp);
};

// ---------------------------------------------------------------- consumer
const onFrame = async (frame, r, did) => {
  const tRx = wall();
  counters.depth++;
  counters.maxDepth = Math.max(counters.maxDepth, counters.depth);
  liveInc(); // the pool's own VideoFrame, closed after this handler settles
  try {
    const slot = slots.get(r);
    if (!slot) return;
    const stamp = { r, did, tRx, depth: counters.depth, live: counters.live };
    switch (cfg.draw) {
      case "2d":
        holdFrame(slot, frame.videoFrame, stamp);
        return;
      case "2d-immediate":
        stamp.tDrawStart = wall();
        slot.ctx.drawImage(frame.videoFrame, 0, 0, cfg.canvasW, cfg.canvasH);
        stamp.tDraw = wall();
        stampBatch.push(stamp);
        return;
      case "none":
        stampBatch.push(stamp);
        return;
      case "webgpu":
        await drawWebGPU(slot, frame.videoFrame, stamp);
        stampBatch.push(stamp);
        return;
    }
  } finally {
    counters.depth--;
    counters.live--;
  }
};

const receiver = client.bindSharedTextureReceiver(sharedTexture);
receiver.consume({
  onFrame,
  onError: (e) => {
    counters.errors++;
    console.error("[e2e-latency] onFrame error", e);
  },
});

ipcRenderer.on("bench-ping", () => {
  const t2 = wall();
  ipcRenderer.send("bench-pong", t2, wall());
});
ipcRenderer.on("bench-flush", () => {
  for (const slot of slots.values()) {
    slot.held?.videoFrame.close();
    slot.held = null;
  }
  flush();
  ipcRenderer.send("bench-flushed", { ...counters });
});

const setup = async () => {
  const grid = document.getElementById("grid");
  grid.style.gridTemplateColumns = `repeat(${cfg.cols}, 1fr)`;
  if (cfg.draw === "webgpu") gpu = await initWebGPU();
  for (const id of cfg.slots) {
    const canvas = document.createElement("canvas");
    canvas.width = cfg.canvasW;
    canvas.height = cfg.canvasH;
    grid.appendChild(canvas);
    const slot = { canvas, ctx: null, gpuCtx: null, held: null };
    if (cfg.draw === "webgpu" && gpu) {
      slot.gpuCtx = canvas.getContext("webgpu");
      slot.gpuCtx.configure({ device: gpu.device, format: gpu.format, alphaMode: "opaque" });
    } else {
      slot.ctx = canvas.getContext("2d");
    }
    slots.set(id, slot);
  }
  counters.timerResMs = probeTimerResolution();
  setInterval(flush, 500);
  requestAnimationFrame(rafLoop);
  ipcRenderer.send("bench-ready", {
    index: cfg.index,
    webgpu: cfg.draw === "webgpu" ? Boolean(gpu) : null,
    adapter: gpu?.adapterInfo ?? null,
    dpr: window.devicePixelRatio,
  });
};

window.addEventListener("DOMContentLoaded", () => {
  setup().catch((e) => {
    console.error(e);
    ipcRenderer.send("bench-ready", { index: cfg.index, webgpu: false, error: `${e}` });
  });
});
