import { isPreviewFrameMessage, PREVIEW_FRAME_CHANNEL } from "./preview-protocol";

/**
 * Renderer-side receiving end of `TextureBridge.forwardPreviewFrames`.
 *
 * Runs wherever Electron's `ipcRenderer` is available — normally the
 * preload script. Pass `ipcRenderer` itself; only `on` / `removeListener`
 * are used, so tests can pass any `EventEmitter`.
 */

type IpcListener = (event: unknown, ...args: unknown[]) => void;

/** The subset of `ipcRenderer` the consumer needs. */
export interface PreviewFrameIpcSource {
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
}

/**
 * One preview frame. `data` is `width * height * 4` bytes of tightly packed,
 * upright RGBA — a `Uint8ClampedArray` view (no copy) over the bytes Electron
 * deserialized for this message, so it can go straight into
 * `new ImageData(frame.data, frame.width, frame.height)` →
 * `ctx.putImageData(...)`, or into `new VideoFrame(frame.data, { format:
 * "RGBA", codedWidth, codedHeight, timestamp })`. Each message gets its own
 * buffer, so it may be kept or transferred (`postMessage(..., [frame.data.buffer])`)
 * — e.g. from the preload to the main world.
 */
export interface PreviewClientFrame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface PreviewFrameHandlers {
  /** Called once per frame with the registration's `extraArgs` as varargs. */
  onFrame(frame: PreviewClientFrame, ...extraArgs: unknown[]): void;
  /**
   * Malformed messages and errors thrown by `onFrame` land here (default:
   * `console.error`). Never interrupts delivery of later frames.
   */
  onError?(error: Error): void;
}

export interface PreviewFrameRegistration {
  /** Stop receiving. Idempotent. */
  dispose(): void;
}

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(`${value}`, { cause: value });

const reportError = (handlers: PreviewFrameHandlers, error: Error): void => {
  if (handlers.onError) {
    handlers.onError(error);
    return;
  }
  console.error("[texture-bridge] preview frame consumer:", error);
};

/**
 * Subscribe to the preview frames `forwardPreviewFrames` sends to this
 * renderer. Several consumers may share one `ipcRenderer`; each `dispose()`
 * removes only its own listener.
 *
 * ```ts
 * // preload.ts
 * import { ipcRenderer } from "electron";
 * import { consumePreviewFrames } from "@napolab/texture-bridge-renderer/client";
 *
 * consumePreviewFrames(ipcRenderer, {
 *   onFrame: (frame, slot) => {
 *     // hand the bytes to the page without a copy
 *     window.postMessage({ slot, ...frame }, "*", [frame.data.buffer]);
 *   },
 * });
 * ```
 */
export const consumePreviewFrames = (
  ipc: PreviewFrameIpcSource,
  handlers: PreviewFrameHandlers,
): PreviewFrameRegistration => {
  const listener: IpcListener = (_event, message, ...extraArgs) => {
    if (!isPreviewFrameMessage(message)) {
      reportError(handlers, new Error("Malformed preview frame message"));
      return;
    }
    const frame: PreviewClientFrame = {
      width: message.width,
      height: message.height,
      data: new Uint8ClampedArray(
        message.data.buffer,
        message.data.byteOffset,
        message.data.byteLength,
      ),
    };
    try {
      handlers.onFrame(frame, ...extraArgs);
    } catch (err) {
      reportError(handlers, toError(err));
    }
  };
  ipc.on(PREVIEW_FRAME_CHANNEL, listener);

  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ipc.removeListener(PREVIEW_FRAME_CHANNEL, listener);
    },
  };
};
