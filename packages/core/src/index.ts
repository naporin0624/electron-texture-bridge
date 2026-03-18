import { TextureSender, TextureReceiver, getPlatform, listSenders } from "@napolab/texture-bridge";
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
if (typeof Symbol.dispose === "symbol") {
  (TextureSender.prototype as any)[Symbol.dispose] = function () {
    this.stop();
  };
  (TextureReceiver.prototype as any)[Symbol.dispose] = function () {
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

export { TextureSender, TextureReceiver, getPlatform, listSenders };
export type { TextureInfo, PaintTexture, Platform, PixelFormat, SenderInfo, ReceivedFrame };

/**
 * Send a texture from an Electron paint event to Syphon/Spout.
 *
 * Handles platform detection and buffer extraction automatically.
 */
export function sendTextureFromPaintEvent(
  sender: InstanceType<typeof TextureSender>,
  textureInfo: TextureInfo | undefined,
): void {
  if (!textureInfo) return;
  const { handle, codedSize } = textureInfo;

  if (process.platform === "win32") {
    const ntHandle = handle.ntHandle;
    if (!ntHandle || !Buffer.isBuffer(ntHandle)) return;
    const handleValue = Number(ntHandle.readBigInt64LE(0));
    sender.send(handleValue, codedSize.width, codedSize.height);
    return;
  }

  if (process.platform === "darwin") {
    const ioSurface = handle.ioSurface;
    if (!ioSurface) return;
    sender.sendSurface(ioSurface, codedSize.width, codedSize.height);
  }
}
