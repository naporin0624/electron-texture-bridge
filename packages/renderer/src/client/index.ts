import type { MainToWorkerMessage } from "./worker-protocol";

export type { MainToWorkerMessage, WorkerToMainMessage, WorkerMessage } from "./worker-protocol";

export interface WorkerRendererOptions {
  /** An existing Worker instance */
  worker: Worker;
  /** Initial canvas width */
  width: number;
  /** Initial canvas height */
  height: number;
  /** Existing canvas element to use (created if omitted) */
  canvas?: HTMLCanvasElement;
  /** Container element to append the canvas to (defaults to document.body) */
  container?: HTMLElement;
}

export interface WorkerRendererHandle {
  /** The canvas element */
  canvas: HTMLCanvasElement;
  /** The worker instance */
  worker: Worker;
  /** Stop observing resize and clean up */
  dispose: () => void;
}

/**
 * Set up a canvas + OffscreenCanvas pipeline to a Web Worker.
 *
 * Creates (or reuses) a canvas, transfers it to the worker,
 * and attaches a ResizeObserver to automatically send resize
 * messages when the canvas dimensions change.
 *
 * This runs in the renderer process (browser context) only.
 */
export function createWorkerRenderer(options: WorkerRendererOptions): WorkerRendererHandle {
  const { worker, width, height } = options;

  const canvas = options.canvas ?? document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  if (!options.canvas) {
    const container = options.container ?? document.body;
    container.appendChild(canvas);
  }

  const offscreen = canvas.transferControlToOffscreen();
  const initMsg: MainToWorkerMessage = { type: "init", canvas: offscreen };
  worker.postMessage(initMsg, [offscreen]);

  let lastW = width;
  let lastH = height;

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width: w, height: h } = entry.contentRect;
      const rw = Math.round(w);
      const rh = Math.round(h);
      if (rw === lastW && rh === lastH) continue;
      lastW = rw;
      lastH = rh;
      const msg: MainToWorkerMessage = { type: "resize", width: rw, height: rh };
      worker.postMessage(msg);
    }
  });

  observer.observe(canvas);

  return {
    canvas,
    worker,
    dispose() {
      observer.disconnect();
    },
  };
}
