/** Messages sent from the main thread to the worker */
export type MainToWorkerMessage =
  | { type: "init"; canvas: OffscreenCanvas }
  | { type: "resize"; width: number; height: number }
  | { type: "dispose" };

/** Messages sent from the worker to the main thread */
export type WorkerToMainMessage = { type: "ready" } | { type: "error"; message: string };

/** Union of all worker messages (convenience re-export) */
export type WorkerMessage = MainToWorkerMessage;
