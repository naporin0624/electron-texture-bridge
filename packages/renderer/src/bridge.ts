import { EventEmitter } from "events";
import { app, BrowserWindow, screen, type Event } from "electron";
import {
  TextureSender,
  sendTextureFromPaintEvent,
  type PaintTexture,
} from "@napolab/texture-bridge-core";
import { PreviewManager } from "./preview-manager";
import { FpsCounter } from "./fps-counter";
import type { TextureBridgeOptions, TextureBridge } from "./types";
import { toError } from "./to-error";

/**
 * Convert a pixel-space size to a device-independent (DIP) size for a given
 * display scaleFactor. Used when `pixelExact: true` is set so the offscreen
 * BrowserWindow's DIP size produces the requested framebuffer pixel count.
 *
 * Math.round (rather than floor / ceil) minimizes the rounding error when the
 * scaleFactor does not divide the pixel size evenly (e.g., 1920 / 1.75 =
 * 1097.14 → 1097 → 1097 × 1.75 = 1919.75, which Chromium typically rounds
 * back to 1920).
 */
export const computeDipSize = (
  pixelWidth: number,
  pixelHeight: number,
  scaleFactor: number,
): { width: number; height: number } => {
  if (scaleFactor <= 0) {
    return { width: Math.max(1, pixelWidth), height: Math.max(1, pixelHeight) };
  }
  return {
    width: Math.max(1, Math.round(pixelWidth / scaleFactor)),
    height: Math.max(1, Math.round(pixelHeight / scaleFactor)),
  };
};

interface PaintEvent extends Event {
  texture?: PaintTexture;
}

class TextureBridgeImpl extends EventEmitter implements TextureBridge {
  private _renderWindow: BrowserWindow;
  private sender: InstanceType<typeof TextureSender>;
  private previewManager: PreviewManager | null;
  private fpsCounter = new FpsCounter();
  private _disposed = false;
  private options: TextureBridgeOptions;

  constructor(
    renderWindow: BrowserWindow,
    sender: InstanceType<typeof TextureSender>,
    previewManager: PreviewManager | null,
    options: TextureBridgeOptions,
  ) {
    super();
    this._renderWindow = renderWindow;
    this.sender = sender;
    this.previewManager = previewManager;
    this.options = options;
  }

  get renderWindow(): BrowserWindow {
    return this._renderWindow;
  }

  get previewWindow(): BrowserWindow | null {
    return this.previewManager?.window ?? null;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  /** Handle a paint event from the offscreen BrowserWindow. */
  handlePaint(event: PaintEvent): void {
    const texture = event.texture;
    if (!texture?.textureInfo) return;

    // If we've been disposed between the paint event and this callback, the
    // underlying sender has been stopped and calling into it would throw
    // "TextureSender has been stopped" for every in-flight paint. Drop the
    // texture cleanly instead of emitting a stream of teardown errors.
    if (this._disposed) {
      texture.release?.();
      return;
    }

    try {
      sendTextureFromPaintEvent(this.sender, texture.textureInfo);
      this.previewManager?.sendFrame(texture);
    } catch (err) {
      this.emit("error", toError(err));
    } finally {
      texture.release?.();
    }

    if (this._disposed) return;
    const fps = this.fpsCounter.tick();
    if (fps !== null) {
      this.emit("fps", fps);
    }
  }

  openPreview(): void {
    if (this._disposed) return;
    if (!this.previewManager) {
      this.previewManager = new PreviewManager(
        this.options.width,
        this.options.height,
        this.options.preview,
      );
    }
    this.previewManager.open();
  }

  closePreview(): void {
    this.previewManager?.close();
  }

  resize(width: number, height: number): void {
    if (this._disposed) return;

    const prevOpts = this.options;
    this.options = { ...this.options, width, height };

    // 1. Resize offscreen BrowserWindow. When `pixelExact` is set the caller's
    //    width/height are pixel-space, so translate to DIP via the primary
    //    display's scaleFactor before passing to setSize.
    const dip =
      this.options.pixelExact === true
        ? computeDipSize(width, height, screen.getPrimaryDisplay().scaleFactor)
        : { width, height };
    this._renderWindow.setSize(dip.width, dip.height);

    // 2. Recreate native sender with new dimensions.
    //    Must stop the old sender first — Spout requires unique sender names.
    //    Sender always stays in pixel-space regardless of pixelExact.
    //    If the new sender fails, restore one with the original dimensions.
    this.sender.stop();
    try {
      this.sender = new TextureSender(this.options.name, width, height);
    } catch (err) {
      this.options = prevOpts;
      const prevDip =
        prevOpts.pixelExact === true
          ? computeDipSize(prevOpts.width, prevOpts.height, screen.getPrimaryDisplay().scaleFactor)
          : { width: prevOpts.width, height: prevOpts.height };
      this._renderWindow.setSize(prevDip.width, prevDip.height);
      this.sender = new TextureSender(prevOpts.name, prevOpts.width, prevOpts.height);
      throw err;
    }

    // 3. Update preview canvas size
    this.previewManager?.updateSize(width, height);

    this.emit("resize", width, height);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // Remove paint listener by destroying the window
    if (!this._renderWindow.isDestroyed()) {
      this._renderWindow.close();
    }

    this.sender.stop();
    this.previewManager?.dispose();
    this.previewManager = null;

    this.emit("disposed");
    this.removeAllListeners();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/**
 * Build the BrowserWindow constructor options for the offscreen renderer.
 *
 * Extracted as a pure function so it can be unit tested without touching
 * Electron's native module — the actual `new BrowserWindow(...)` call lives
 * in `createTextureBridge`.
 *
 * `options.includeAlpha` flips the OSR pipeline into alpha-preserving mode:
 * `transparent: true` plus `backgroundColor: "#00000000"` on the BrowserWindow
 * is the documented recipe for Chromium to emit per-pixel alpha into the
 * shared texture. The page itself must use a transparent background
 * (`html, body { background: transparent }`) for the alpha to mean anything.
 */
export const buildBrowserWindowOptions = (
  options: TextureBridgeOptions,
): Electron.BrowserWindowConstructorOptions => {
  const { width, height, webPreferences, includeAlpha, pixelExact } = options;

  return {
    width,
    height,
    show: false,
    // `enableLargerThanScreen` is documented as macOS-only but is harmless on
    // other platforms. We set it whenever `pixelExact` is requested so the
    // offscreen window's DIP size — which may be larger than the display when
    // the system DPI is < 100% — is not clamped to the work area.
    ...(pixelExact === true ? { enableLargerThanScreen: true } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: { useSharedTexture: true },
      ...webPreferences,
    },
    // Hex `#RRGGBBAA` with alpha=0x00 is the explicit "fully transparent
    // backdrop" signal Chromium honors on offscreen render surfaces. The
    // `transparent: true` flag alone leaves the compositor painting opaque,
    // so both keys must be applied together.
    ...(includeAlpha ? { transparent: true, backgroundColor: "#00000000" } : {}),
  };
};

/**
 * Create a fully-wired texture bridge: offscreen window, native sender,
 * optional preview, and FPS tracking.
 *
 * Must be called after `app.whenReady()`.
 */
export const createTextureBridge = async (
  options: TextureBridgeOptions,
): Promise<TextureBridge> => {
  if (!app.isReady()) {
    throw new Error("createTextureBridge() must be called after app.whenReady()");
  }

  const { name, width, height, frameRate = 60, rendererUrl, preview, pixelExact } = options;

  // ---- Offscreen BrowserWindow ----
  // When pixelExact is set, the caller's width/height are pixel-space — translate
  // to DIP via the primary display's scaleFactor before constructing the window
  // so the resulting framebuffer lands at the requested pixel count. The sender
  // below always uses pixel-space dimensions.
  const windowOptions: TextureBridgeOptions =
    pixelExact === true
      ? { ...options, ...computeDipSize(width, height, screen.getPrimaryDisplay().scaleFactor) }
      : options;
  const renderWindow = new BrowserWindow(buildBrowserWindowOptions(windowOptions));

  // ---- Native sender ----
  const sender = new TextureSender(name, width, height);

  // ---- Preview ----
  const previewManager =
    preview && preview.enabled !== false ? new PreviewManager(width, height, preview) : null;
  previewManager?.open();

  // ---- Bridge instance ----
  const bridge = new TextureBridgeImpl(renderWindow, sender, previewManager, options);

  // ---- Paint handler (delegates to instance method, no private field access) ----
  renderWindow.webContents.on("paint", (event: PaintEvent) => {
    bridge.handlePaint(event);
  });

  renderWindow.webContents.setFrameRate(frameRate);

  // ---- Load renderer URL ----
  const isUrlScheme =
    rendererUrl.startsWith("http://") ||
    rendererUrl.startsWith("https://") ||
    rendererUrl.startsWith("file://");
  if (isUrlScheme) {
    await renderWindow.loadURL(rendererUrl);
  } else {
    await renderWindow.loadFile(rendererUrl);
  }

  bridge.emit("ready");

  return bridge;
};
