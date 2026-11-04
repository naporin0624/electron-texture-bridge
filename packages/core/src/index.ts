import { Result } from "neverthrow";
import {
  TextureSender,
  TextureReceiver,
  closeNativeHandle,
  getPlatform,
  listSenders,
} from "@napolab/texture-bridge";
import { TextureSendError } from "./errors";
import type {
  TextureInfo,
  PaintTexture,
  Platform,
  PixelFormat,
  SenderInfo,
  ReceivedFrame,
  PaintDefect,
} from "./types";

// Attach Symbol.dispose to native classes so `using` declarations work.
// napi-rs cannot expose symbol-named methods, so we patch the prototypes here.
// `function` expressions (not arrows) are required for the `this` binding.
if (typeof Symbol.dispose === "symbol") {
  TextureSender.prototype[Symbol.dispose] = function (this: InstanceType<typeof TextureSender>) {
    this.stop();
  };
  TextureReceiver.prototype[Symbol.dispose] = function (
    this: InstanceType<typeof TextureReceiver>,
  ) {
    this.stop();
  };
}

// Augment native class types with Symbol.dispose (added at runtime above).
declare module "@napolab/texture-bridge" {
  interface TextureSender {
    [Symbol.dispose](): void;
  }
  interface TextureReceiver {
    [Symbol.dispose](): void;
  }
}

export { TextureSender, TextureReceiver, closeNativeHandle, getPlatform, listSenders };
export { TextureSendError } from "./errors";
export type {
  TextureInfo,
  PaintTexture,
  Platform,
  PixelFormat,
  SenderInfo,
  ReceivedFrame,
  PaintDefect,
};
export type { SharedTextureFrame, PreviewFrame } from "@napolab/texture-bridge";

/**
 * Platform dispatch onto the native sender. Returns a {@link PaintDefect}
 * when the frame was dropped (no shareable handle / unsupported platform).
 * `send()` / `sendSurface()` can still throw (e.g. "TextureSender has been
 * stopped") — the public entry point below folds that throw through
 * `Result.fromThrowable`.
 */
const dispatchSend = (
  sender: InstanceType<typeof TextureSender>,
  textureInfo: TextureInfo,
): PaintDefect | undefined => {
  const { handle, codedSize } = textureInfo;

  switch (process.platform) {
    case "win32": {
      const ntHandle = handle.ntHandle;
      if (!ntHandle || !Buffer.isBuffer(ntHandle)) return { reason: "no-nt-handle" };
      const handleValue = Number(ntHandle.readBigInt64LE(0));
      sender.send(handleValue, codedSize.width, codedSize.height);
      return undefined;
    }
    case "darwin": {
      const ioSurface = handle.ioSurface;
      if (!ioSurface) return { reason: "no-io-surface" };
      sender.sendSurface(ioSurface, codedSize.width, codedSize.height);
      return undefined;
    }
    default:
      return { reason: "unsupported-platform", platform: process.platform };
  }
};

/**
 * `dispatchSend` with its throw folded into
 * `Result<PaintDefect | undefined, TextureSendError>`. Bound once at module
 * scope — `Result.fromThrowable` forwards the arguments.
 */
const safeDispatchSend = Result.fromThrowable(
  dispatchSend,
  (cause) => new TextureSendError(cause instanceof Error ? cause.message : `${cause}`, { cause }),
);

/**
 * Send a texture from an Electron paint event to Syphon/Spout.
 *
 * Handles platform detection and buffer extraction automatically.
 *
 * @returns `undefined` when the texture was handed to the sender, or a
 * {@link PaintDefect} describing why the frame was dropped. Drops are normal
 * no-ops (e.g. Chromium delivered a paint without a shareable handle), not
 * errors — but callers should surface them instead of letting output go
 * silently black. The native `send()` / `sendSurface()` throw is wrapped with
 * `Result.fromThrowable` and consumed here with a single `.match` — the
 * `Result` never crosses the public API. On native failure a
 * {@link TextureSendError} is thrown with the original message preserved and
 * the thrown value on `Error.cause`.
 */
export const sendTextureFromPaintEvent = (
  sender: InstanceType<typeof TextureSender>,
  textureInfo: TextureInfo | undefined,
): PaintDefect | undefined => {
  if (!textureInfo) return { reason: "no-texture" };

  return safeDispatchSend(sender, textureInfo).match(
    (defect) => defect,
    (error) => {
      throw error;
    },
  );
};
