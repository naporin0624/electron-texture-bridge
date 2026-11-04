/**
 * Wire format of `TextureBridge.forwardPreviewFrames` — shared by the main
 * process sender (bridge.ts) and the renderer receiver
 * (`consumePreviewFrames`). Electron-free so it can live in `/client`.
 */

/** IPC channel the main process sends preview frames on (`webContents.send`). */
export const PREVIEW_FRAME_CHANNEL = "texture-bridge:preview-frame";

/**
 * First argument of every {@link PREVIEW_FRAME_CHANNEL} message; the
 * registration's `extraArgs` follow as further arguments.
 *
 * `data` is `width * height * 4` bytes of tightly packed RGBA, top row first.
 */
export interface PreviewFrameMessage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Narrow an IPC argument to a well-formed {@link PreviewFrameMessage}. */
export const isPreviewFrameMessage = (value: unknown): value is PreviewFrameMessage => {
  if (typeof value !== "object" || value === null) return false;
  if (!("width" in value) || !("height" in value) || !("data" in value)) return false;
  const { width, height, data } = value;
  if (typeof width !== "number" || typeof height !== "number") return false;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return false;
  }
  return data instanceof Uint8Array && data.byteLength === width * height * 4;
};
