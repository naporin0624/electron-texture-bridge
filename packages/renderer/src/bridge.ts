import { EventEmitter } from "events";
import { app, BrowserWindow, type Event } from "electron";
import {
  TextureSender,
  sendTextureFromPaintEvent,
  type PaintTexture,
} from "@napolab/texture-bridge-core";
import { PreviewManager } from "./preview-manager";
import { FpsCounter } from "./fps-counter";
import type { TextureBridgeOptions, TextureBridge } from "./types";

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

    this.options = { ...this.options, width, height };

    // 1. Resize offscreen BrowserWindow
    this._renderWindow.setSize(width, height);

    // 2. Recreate native sender with new dimensions
    this.sender.stop();
    this.sender = new TextureSender(this.options.name, width, height);

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
}

/**
 * Create a fully-wired texture bridge: offscreen window, native sender,
 * optional preview, and FPS tracking.
 *
 * Must be called after `app.whenReady()`.
 */
export async function createTextureBridge(options: TextureBridgeOptions): Promise<TextureBridge> {
  if (!app.isReady()) {
    throw new Error("createTextureBridge() must be called after app.whenReady()");
  }

  const { name, width, height, frameRate = 60, rendererUrl, preview, webPreferences } = options;

  // ---- Offscreen BrowserWindow ----
  const renderWindow = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: { useSharedTexture: true },
      ...webPreferences,
    },
  });

  // ---- Native sender ----
  const sender = new TextureSender(name, width, height);

  // ---- Preview ----
  let previewManager: PreviewManager | null = null;
  if (preview?.enabled !== false && preview) {
    previewManager = new PreviewManager(width, height, preview);
    previewManager.open();
  }

  // ---- Bridge instance ----
  const bridge = new TextureBridgeImpl(renderWindow, sender, previewManager, options);

  // ---- Paint handler ----
  renderWindow.webContents.on("paint", (event: PaintEvent) => {
    const texture = event.texture;
    if (!texture?.textureInfo) return;

    try {
      sendTextureFromPaintEvent((bridge as any).sender, texture.textureInfo);
      (bridge as any).previewManager?.sendFrame(texture);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      bridge.emit("error", error);
    } finally {
      texture.release?.();
    }

    const fps = (bridge as any).fpsCounter.tick();
    if (fps !== null) {
      bridge.emit("fps", fps);
    }
  });

  renderWindow.webContents.setFrameRate(frameRate);

  // ---- Load renderer URL ----
  if (rendererUrl.startsWith("http://") || rendererUrl.startsWith("https://")) {
    await renderWindow.loadURL(rendererUrl);
  } else if (rendererUrl.startsWith("file://")) {
    await renderWindow.loadURL(rendererUrl);
  } else {
    await renderWindow.loadFile(rendererUrl);
  }

  bridge.emit("ready");

  return bridge;
}
