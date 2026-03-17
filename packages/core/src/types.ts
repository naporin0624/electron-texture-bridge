/** Supported pixel formats for shared textures */
export type PixelFormat = "bgra" | "nv12" | "rgba" | "rgbaf16";

/** Electron paint event texture info */
export interface TextureInfo {
  pixelFormat: PixelFormat;
  codedSize: { width: number; height: number };
  visibleRect: { x: number; y: number; width: number; height: number };
  handle: {
    ntHandle?: Buffer; // Windows (Electron 40+)
    ioSurface?: Buffer; // macOS
  };
}

/** Electron paint event texture with release callback */
export interface PaintTexture {
  textureInfo: TextureInfo;
  release?: () => void;
}

/** Platform-specific texture sharing protocol */
export type Platform = "spout" | "syphon-metal" | "unsupported";

/** Information about an available texture sender (Syphon server / Spout sender) */
export interface SenderInfo {
  name: string;
  appName?: string;
  uuid?: string;
}

/** A received frame with RGBA pixel data */
export interface ReceivedFrame {
  data: Buffer;
  width: number;
  height: number;
}
