/**
 * Preview window preload script (CJS).
 *
 * Owns the whole preview pipeline: binds Electron's shared-texture receiver
 * slot via `bindSharedTextureReceiver`, initialises WebGPU on the page's
 * canvas (the isolated world shares the DOM with `preview.html`), and draws
 * every delivered frame. `preview.html` is markup + styles only.
 *
 * Frame lifetime is owned by `consume()`: it closes the VideoFrame after
 * `onFrame` settles and releases the imported texture exactly once, so this
 * script never calls `close()` / `release()` itself.
 *
 * This file is copied verbatim to `dist/assets/` (not bundled), so it loads
 * the built client entry by a path relative to `dist/assets/`. That path is
 * the `exports["./client"].require` target and is pinned by
 * `src/__tests__/preview-assets.test.ts`. Requiring a non-`electron` module
 * from a preload needs `sandbox: false` (see PreviewManager).
 */
const { ipcRenderer, sharedTexture } = require("electron");
const { bindSharedTextureReceiver } = require("../client/index.cjs");

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const FPS_WINDOW_MS = 1000;

const SHADER_CODE = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) texCoord: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );

  var output: VertexOutput;
  output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  output.texCoord = uv[vertexIndex];
  return output;
}

@group(0) @binding(0) var externalTexture: texture_external;
@group(0) @binding(1) var texSampler: sampler;

@fragment
fn fragmentMain(@location(0) texCoord: vec2f) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(externalTexture, texSampler, texCoord);
}
`;

/** Canvas size from the `?w=&h=` query PreviewManager passes to loadFile. */
const readCanvasSize = (search) => {
  const params = new URLSearchParams(search);
  return {
    width: parseInt(params.get("w"), 10) || DEFAULT_WIDTH,
    height: parseInt(params.get("h"), 10) || DEFAULT_HEIGHT,
  };
};

/** Resolves once the page's DOM is parsed (preloads run before `<body>`). */
const whenDOMReady = (doc) =>
  new Promise((resolve) => {
    if (doc.readyState !== "loading") {
      resolve();
      return;
    }
    doc.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
  });

/**
 * Bind the receiver slot and tie the binding's lifetime to this page.
 * `updateSize()` reloads the page, which fires `beforeunload` first, so the
 * binding is always released before the next load binds again.
 */
const bindReceiver = (target, win) => {
  const receiver = bindSharedTextureReceiver(target);
  win.addEventListener("beforeunload", () => receiver.dispose(), { once: true });
  return receiver;
};

/** Initialise WebGPU on `canvas` and return the resources `renderFrame` needs. */
const initWebGPU = async (gpu, canvas) => {
  if (!gpu) throw new Error("WebGPU not supported");

  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error("No GPU adapter found");

  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  const format = gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const shaderModule = device.createShaderModule({ code: SHADER_CODE });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: shaderModule, entryPoint: "vertexMain" },
    fragment: { module: shaderModule, entryPoint: "fragmentMain", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  return { device, context, pipeline, sampler, bindGroupLayout };
};

/** Draw one VideoFrame to the canvas. Throws are reported via `onError`. */
const renderFrame = (gpu, videoFrame) => {
  const externalTexture = gpu.device.importExternalTexture({ source: videoFrame });
  const bindGroup = gpu.device.createBindGroup({
    layout: gpu.bindGroupLayout,
    entries: [
      { binding: 0, resource: externalTexture },
      { binding: 1, resource: gpu.sampler },
    ],
  });

  const commandEncoder = gpu.device.createCommandEncoder();
  const renderPass = commandEncoder.beginRenderPass({
    colorAttachments: [
      {
        view: gpu.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  renderPass.setPipeline(gpu.pipeline);
  renderPass.setBindGroup(0, bindGroup);
  renderPass.draw(3);
  renderPass.end();

  gpu.device.queue.submit([commandEncoder.finish()]);
};

const createFPSState = (now) => ({ frameCount: 0, windowStart: now, fps: 0 });

/** Count one frame; recompute `fps` once per FPS_WINDOW_MS. Pure. */
const tickFPS = (state, now) => {
  const frameCount = state.frameCount + 1;
  const elapsed = now - state.windowStart;
  if (elapsed < FPS_WINDOW_MS) return { ...state, frameCount };
  return { frameCount: 0, windowStart: now, fps: (frameCount * 1000) / elapsed };
};

const formatFrameInfo = (fps, videoFrame) =>
  `GPU Zero-Copy | FPS: ${fps.toFixed(1)} | ${videoFrame.displayWidth}x${videoFrame.displayHeight}`;

const showError = (infoEl, err) => {
  infoEl.className = "error";
  infoEl.textContent = `WebGPU Error: ${err instanceof Error ? err.message : `${err}`}`;
};

/** Init WebGPU, register the drawing consumer, then tell main we're ready. */
const startPreview = async (receiver, doc, gpu, search) => {
  const canvas = doc.getElementById("preview");
  const infoEl = doc.getElementById("info");
  const { width, height } = readCanvasSize(search);
  canvas.width = width;
  canvas.height = height;

  const resources = await initWebGPU(gpu, canvas);
  infoEl.textContent = "WebGPU ready, waiting for frames...";

  let fpsState = createFPSState(performance.now());
  receiver.consume({
    onFrame: ({ videoFrame }) => {
      renderFrame(resources, videoFrame);
      fpsState = tickFPS(fpsState, performance.now());
      infoEl.textContent = formatFrameInfo(fpsState.fps, videoFrame);
    },
    onError: (err) => {
      console.error("[preview] render error:", err);
    },
  });

  ipcRenderer.send("preview-ready");
};

const main = async () => {
  try {
    // Bind synchronously during preload evaluation: frames that arrive before
    // a consumer is registered are drained and released by the binding.
    const receiver = bindReceiver(sharedTexture, window);
    await whenDOMReady(document);
    await startPreview(receiver, document, navigator.gpu, location.search);
  } catch (err) {
    console.error("[preview] init error:", err);
    await whenDOMReady(document);
    showError(document.getElementById("info"), err);
  }
};

void main();
