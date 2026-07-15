import { BrowserWindow, ipcMain, sharedTexture } from "electron";
import path from "path";
import type { TextureInfo } from "@napolab/texture-bridge-core";
import { Result, ResultAsync } from "neverthrow";
import { toError } from "./to-error";
import type { PreviewOptions } from "./types";

/**
 * Resolves asset paths relative to dist/assets/. `__dirname` is provided
 * natively in CJS output and injected via tsdown's `--shims` flag in ESM output
 * (see package.json build script), so this works in both module formats.
 */
const assetPath = (filename: string): string => {
  return path.join(__dirname, "assets", filename);
};

/**
 * `importSharedTexture` with its throw folded into a Result, bound once at
 * module scope (arguments are forwarded — no IIFE-style immediate call).
 */
const safeImportSharedTexture = Result.fromThrowable(
  (textureInfo: TextureInfo) => sharedTexture.importSharedTexture({ textureInfo }),
  toError,
);

export class PreviewManager {
  private win: BrowserWindow | null = null;
  private ready = false;
  private width: number;
  private height: number;
  private title: string;
  private previewReadyListener: ((event: Electron.IpcMainEvent) => void) | null = null;

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

  private handlePreviewReady(event: Electron.IpcMainEvent): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (event.sender.id !== this.win.webContents.id) return;
    this.ready = true;
  }

  private removePreviewReadyListener(): void {
    if (!this.previewReadyListener) return;
    ipcMain.removeListener("preview-ready", this.previewReadyListener);
    this.previewReadyListener = null;
  }

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

    const listener = (event: Electron.IpcMainEvent): void => {
      this.handlePreviewReady(event);
    };
    this.previewReadyListener = listener;
    ipcMain.on("preview-ready", listener);

    this.win.loadFile(assetPath("preview.html"), {
      query: { w: `${this.width}`, h: `${this.height}` },
    });

    this.win.on("closed", () => {
      this.win = null;
      this.ready = false;
      this.removePreviewReadyListener();
    });
  }

  sendFrame(texture: { textureInfo: TextureInfo }): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.ready) return;

    // Preview delivery is best-effort by design: both failure channels are
    // intentionally discarded at this edge (the main bridge already reports
    // real pipeline errors).
    void safeImportSharedTexture(texture.textureInfo)
      .asyncAndThen((imported) =>
        ResultAsync.fromPromise(
          sharedTexture.sendSharedTexture({
            frame: win.webContents.mainFrame,
            importedSharedTexture: imported,
          }),
          toError,
        ),
      )
      .match(
        () => undefined,
        () => undefined,
      );
  }

  updateSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    win.loadFile(assetPath("preview.html"), {
      query: { w: `${width}`, h: `${height}` },
    });
  }

  close(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.close();
    this.win = null;
    this.ready = false;
  }

  dispose(): void {
    this.removePreviewReadyListener();
    this.close();
  }
}
