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
export type { TextureInfo, PaintTexture, Platform, PixelFormat, SenderInfo, ReceivedFrame };
export type { SharedTextureFrame } from "@napolab/texture-bridge";

/**
 * Platform dispatch onto the native sender. `send()` / `sendSurface()` can
 * throw (e.g. "TextureSender has been stopped") — the public entry point
 * below folds that throw through `Result.fromThrowable`.
 */
const dispatchSend = (
  sender: InstanceType<typeof TextureSender>,
  textureInfo: TextureInfo,
): void => {
  const { handle, codedSize } = textureInfo;

  switch (process.platform) {
    case "win32": {
      const ntHandle = handle.ntHandle;
      if (!ntHandle || !Buffer.isBuffer(ntHandle)) return;
      const handleValue = parseInt(`${ntHandle.readBigInt64LE(0)}`, 10);
      sender.send(handleValue, codedSize.width, codedSize.height);
      return;
    }
    case "darwin": {
      const ioSurface = handle.ioSurface;
      if (!ioSurface) return;
      sender.sendSurface(ioSurface, codedSize.width, codedSize.height);
      return;
    }
  }
};

/**
 * Send a texture from an Electron paint event to Syphon/Spout.
 *
 * Handles platform detection and buffer extraction automatically. The native
 * `send()` / `sendSurface()` throw is wrapped with `Result.fromThrowable` and
 * consumed here with `.match` — the `Result` never crosses the public API. On
 * failure a `TextureSendError` is thrown with the original message preserved
 * and the thrown value on `Error.cause`.
 */
export const sendTextureFromPaintEvent = (
  sender: InstanceType<typeof TextureSender>,
  textureInfo: TextureInfo | undefined,
): void => {
  if (!textureInfo) return;
  Result.fromThrowable(
    () => {
      dispatchSend(sender, textureInfo);
    },
    (cause) => new TextureSendError(cause instanceof Error ? cause.message : `${cause}`, { cause }),
  )().match(
    () => undefined,
    (error) => {
      throw error;
    },
  );
};
