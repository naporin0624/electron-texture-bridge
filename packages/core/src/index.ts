import { TextureSender, getPlatform } from "@napolab/texture-bridge";
import type { TextureInfo, PaintTexture, Platform, PixelFormat } from "./types";

export { TextureSender, getPlatform };
export type { TextureInfo, PaintTexture, Platform, PixelFormat };

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
