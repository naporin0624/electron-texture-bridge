/**
 * Three.js + GLSL Raymarching Render Worker
 *
 * This worker renders VJ-style visuals using Three.js with custom GLSL shaders.
 * The rendered output is captured by Electron's paint event and sent to
 * Syphon/Spout for use in VJ software like Resolume, VDMX, OBS, etc.
 */

import * as THREE from "three";
import vertexShader from "./shaders/raymarching.vert?raw";
import fragmentShader from "./shaders/raymarching.frag?raw";

// Declare self as worker context
declare const self: DedicatedWorkerGlobalScope;

// ============================================================================
// Worker State
// ============================================================================

/** Everything `init()` creates — present together or not at all. */
interface RenderContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  material: THREE.ShaderMaterial;
}

/** Module-level mutable state; property writes only (repo bans `let`). */
const worker = {
  context: null as RenderContext | null,
  startTime: 0,
  canvasSize: { width: 1920, height: 1080 },
};

const audioData = {
  bass: 0,
  mid: 0,
  high: 0,
  beat: 0,
};

// ============================================================================
// Rendering
// ============================================================================

const lerp = (a: number, b: number, t: number): number => {
  return a + (b - a) * t;
};

const animate = (): void => {
  requestAnimationFrame(animate);

  const context = worker.context;
  if (!context) return;

  const elapsed = (performance.now() - worker.startTime) / 1000;
  context.material.uniforms.u_time.value = elapsed;
  context.material.uniforms.u_bass.value = audioData.bass;
  context.material.uniforms.u_mid.value = audioData.mid;
  context.material.uniforms.u_high.value = audioData.high;
  context.material.uniforms.u_beat.value = audioData.beat;

  audioData.beat *= 0.92;

  context.renderer.render(context.scene, context.camera);
};

const resize = (width: number, height: number): void => {
  const context = worker.context;
  if (!context) return;

  worker.canvasSize = { width, height };
  context.renderer.setSize(width, height, false);
  context.material.uniforms.u_resolution.value.set(width, height);

  console.log(`[render-worker] Resized to ${width}x${height}`);
};

const init = (canvas: OffscreenCanvas): void => {
  worker.canvasSize = { width: canvas.width, height: canvas.height };
  worker.startTime = performance.now();

  const renderer = new THREE.WebGLRenderer({
    canvas: canvas as unknown as HTMLCanvasElement,
    antialias: true,
    // alpha:true + clearAlpha:0 lets the fragment shader's gl_FragColor.a
    // flow through to the framebuffer, which the createTextureBridge
    // `includeAlpha` option then forwards into the Syphon/Spout BGRA texture.
    alpha: true,
    premultipliedAlpha: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });

  // updateStyle: false is required for OffscreenCanvas (no style property)
  renderer.setSize(worker.canvasSize.width, worker.canvasSize.height, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      u_time: { value: 0.0 },
      u_resolution: {
        value: new THREE.Vector2(worker.canvasSize.width, worker.canvasSize.height),
      },
      u_bass: { value: 0.0 },
      u_mid: { value: 0.0 },
      u_high: { value: 0.0 },
      u_beat: { value: 0.0 },
    },
    depthTest: false,
    depthWrite: false,
  });

  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  worker.context = { renderer, scene, camera, material };

  animate();

  console.log("[render-worker] Three.js initialized with raymarching shader");
};

// ============================================================================
// Message Handler
// ============================================================================

type WorkerEvent =
  | { type: "init"; canvas: OffscreenCanvas }
  | { type: "resize"; width: number; height: number }
  | { type: "audio"; bass?: number; mid?: number; high?: number }
  | { type: "beat" };

self.onmessage = (e: MessageEvent<WorkerEvent>) => {
  const msg = e.data;

  switch (msg.type) {
    case "init":
      init(msg.canvas);
      break;

    case "resize":
      resize(msg.width, msg.height);
      break;

    case "audio":
      audioData.bass = lerp(audioData.bass, msg.bass ?? audioData.bass, 0.3);
      audioData.mid = lerp(audioData.mid, msg.mid ?? audioData.mid, 0.3);
      audioData.high = lerp(audioData.high, msg.high ?? audioData.high, 0.3);
      break;

    case "beat":
      audioData.beat = 1.0;
      break;

    default: {
      const _exhaustive: never = msg;
      throw new Error(`unhandled worker message: ${JSON.stringify(_exhaustive)}`);
    }
  }
};
