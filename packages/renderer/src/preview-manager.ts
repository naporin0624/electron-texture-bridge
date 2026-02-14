import { BrowserWindow, ipcMain, sharedTexture } from "electron";
import path from "path";
import type { PreviewOptions } from "./types";

/** Resolves asset paths relative to dist/assets/ regardless of CJS/ESM */
function assetPath(filename: string): string {
  return path.join(__dirname, "assets", filename);
}

export class PreviewManager {
  private win: BrowserWindow | null = null;
  private ready = false;
  private width: number;
  private height: number;
  private title: string;

  constructor(width: number, height: number, options?: PreviewOptions) {
    this.width = width;
    this.height = height;
    this.title = options?.title ?? "Preview (GPU Zero-Copy)";
  }

  get window(): BrowserWindow | null {
    return this.win;
  }

  get isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  private onPreviewReady = (_event: Electron.IpcMainEvent): void => {
    if (!this.win || this.win.isDestroyed()) return;
    if (_event.sender.id !== this.win.webContents.id) return;
    this.ready = true;
  };

  open(): void {
    if (this.isOpen) return;

    this.ready = false;

    this.win = new BrowserWindow({
      width: Math.round(this.width / 2),
      height: Math.round(this.height / 2),
      title: this.title,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: assetPath("preview-preload.js"),
      },
    });

    ipcMain.on("preview-ready", this.onPreviewReady);

    this.win.loadFile(assetPath("preview.html"), {
      query: { w: String(this.width), h: String(this.height) },
    });

    this.win.on("closed", () => {
      this.win = null;
      this.ready = false;
      ipcMain.removeListener("preview-ready", this.onPreviewReady);
    });
  }

  sendFrame(texture: { textureInfo: unknown }): void {
    if (!this.win || this.win.isDestroyed() || !this.ready) return;

    try {
      const imported = sharedTexture.importSharedTexture({
        textureInfo: texture.textureInfo as Electron.SharedTextureImportTextureInfo,
      });
      if (!imported) return;

      sharedTexture
        .sendSharedTexture({
          frame: this.win.webContents.mainFrame,
          importedSharedTexture: imported,
        })
        .catch(() => {});
    } catch {
      // Ignore preview send errors
    }
  }

  updateSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (!this.isOpen) return;
    this.win!.loadFile(assetPath("preview.html"), {
      query: { w: String(width), h: String(height) },
    });
  }

  close(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.close();
    this.win = null;
    this.ready = false;
  }

  dispose(): void {
    ipcMain.removeListener("preview-ready", this.onPreviewReady);
    this.close();
  }
}
