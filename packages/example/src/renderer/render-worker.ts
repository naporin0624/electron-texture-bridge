/**
 * Three.js + GLSL Render Worker with Multi-Scene Support
 *
 * This worker renders VJ-style visuals using Three.js with custom GLSL shaders.
 * The rendered output is captured by Electron's paint event and sent to
 * Syphon/Spout for use in VJ software like Resolume, VDMX, OBS, etc.
 *
 * Scenes can be switched at runtime via postMessage({ type: 'scene', index }).
 */

import * as THREE from "three";
import vertexShader from "./shaders/raymarching.vert?raw";
import raymarchingFrag from "./shaders/raymarching.frag?raw";
import fractalFrag from "./shaders/fractal.frag?raw";
import voronoiFrag from "./shaders/voronoi.frag?raw";

// Declare self as worker context
declare const self: DedicatedWorkerGlobalScope;

// ============================================================================
// Scene Registry
// ============================================================================

const scenes = [
  { name: "Raymarching", fragmentShader: raymarchingFrag },
  { name: "Fractal", fragmentShader: fractalFrag },
  { name: "Voronoi", fragmentShader: voronoiFrag },
];

let currentSceneIndex = 0;

// ============================================================================
// Worker State
// ============================================================================

let renderer: THREE.WebGLRenderer | null = null;
let threeScene: THREE.Scene | null = null;
let camera: THREE.OrthographicCamera | null = null;
let material: THREE.ShaderMaterial | null = null;
let mesh: THREE.Mesh | null = null;
let startTime: number = 0;
let canvasSize = { width: 1920, height: 1080 };

const audioData = {
  bass: 0,
  mid: 0,
  high: 0,
  beat: 0,
};

// ============================================================================
// Message Handler
// ============================================================================

self.onmessage = (e: MessageEvent) => {
  const { type, ...data } = e.data;

  switch (type) {
    case "init":
      init(data.canvas as OffscreenCanvas);
      break;

    case "resize":
      resize(data.width, data.height);
      break;

    case "audio":
      audioData.bass = lerp(audioData.bass, data.bass ?? audioData.bass, 0.3);
      audioData.mid = lerp(audioData.mid, data.mid ?? audioData.mid, 0.3);
      audioData.high = lerp(audioData.high, data.high ?? audioData.high, 0.3);
      break;

    case "beat":
      audioData.beat = 1.0;
      break;

    case "scene":
      switchScene(data.index);
      break;
  }
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ============================================================================
// Material Creation
// ============================================================================

function createMaterial(fragmentShader: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      u_time: { value: 0.0 },
      u_resolution: {
        value: new THREE.Vector2(canvasSize.width, canvasSize.height),
      },
      u_bass: { value: 0.0 },
      u_mid: { value: 0.0 },
      u_high: { value: 0.0 },
      u_beat: { value: 0.0 },
    },
    depthTest: false,
    depthWrite: false,
  });
}

// ============================================================================
// Scene Switching
// ============================================================================

function switchScene(index: number) {
  if (index < 0 || index >= scenes.length) return;
  if (index === currentSceneIndex) return;
  if (!mesh) return;

  const scene = scenes[index];
  const oldMaterial = material;

  material = createMaterial(scene.fragmentShader);
  mesh.material = material;
  currentSceneIndex = index;

  if (oldMaterial) oldMaterial.dispose();

  console.log(`[render-worker] Switched to scene ${index + 1}: ${scene.name}`);
}

// ============================================================================
// Three.js Initialization
// ============================================================================

function init(canvas: OffscreenCanvas) {
  canvasSize = { width: canvas.width, height: canvas.height };
  startTime = performance.now();

  renderer = new THREE.WebGLRenderer({
    canvas: canvas as unknown as HTMLCanvasElement,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });

  // updateStyle: false is required for OffscreenCanvas (no style property)
  renderer.setSize(canvasSize.width, canvasSize.height, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  threeScene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  material = createMaterial(scenes[currentSceneIndex].fragmentShader);

  const geometry = new THREE.PlaneGeometry(2, 2);
  mesh = new THREE.Mesh(geometry, material);
  threeScene.add(mesh);

  animate();

  console.log(
    `[render-worker] Three.js initialized with ${scenes[currentSceneIndex].name} shader`,
  );
}

function resize(width: number, height: number) {
  if (!renderer || !material) return;

  canvasSize = { width, height };
  renderer.setSize(width, height, false);
  material.uniforms.u_resolution.value.set(width, height);

  console.log(`[render-worker] Resized to ${width}x${height}`);
}

// ============================================================================
// Animation Loop
// ============================================================================

function animate() {
  requestAnimationFrame(animate);

  if (!renderer || !threeScene || !camera || !material) return;

  const elapsed = (performance.now() - startTime) / 1000;
  material.uniforms.u_time.value = elapsed;
  material.uniforms.u_bass.value = audioData.bass;
  material.uniforms.u_mid.value = audioData.mid;
  material.uniforms.u_high.value = audioData.high;
  material.uniforms.u_beat.value = audioData.beat;

  audioData.beat *= 0.92;

  renderer.render(threeScene, camera);
}
