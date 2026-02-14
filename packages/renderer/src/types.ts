import type { BrowserWindow } from "electron";

/** Options for the preview window */
export interface PreviewOptions {
  enabled?: boolean;
  width?: number;
  height?: number;
  title?: string;
}

/** Options for createTextureBridge() */
export interface TextureBridgeOptions {
  /** Syphon/Spout sender name visible to VJ software */
  name: string;
  /** Texture width in pixels */
  width: number;
  /** Texture height in pixels */
  height: number;
  /** Target frame rate (default: 60) */
  frameRate?: number;
  /** URL to load in the offscreen renderer (file:// or http://) */
  rendererUrl: string;
  /** Preview window options */
  preview?: PreviewOptions;
  /** Additional webPreferences for the offscreen BrowserWindow */
  webPreferences?: Electron.WebPreferences;
}

/** Events emitted by TextureBridge */
export interface BridgeEvents {
  fps: [fps: number];
  ready: [];
  error: [error: Error];
  disposed: [];
  resize: [width: number, height: number];
}

/** High-level texture bridge handle */
export interface TextureBridge {
  on<K extends keyof BridgeEvents>(event: K, listener: (...args: BridgeEvents[K]) => void): this;
  off<K extends keyof BridgeEvents>(event: K, listener: (...args: BridgeEvents[K]) => void): this;
  once<K extends keyof BridgeEvents>(event: K, listener: (...args: BridgeEvents[K]) => void): this;

  /** Open the preview window (no-op if already open) */
  openPreview(): void;
  /** Close the preview window (no-op if already closed) */
  closePreview(): void;

  /** Resize all layers: offscreen window, sender, preview, and worker */
  resize(width: number, height: number): void;

  /** The offscreen BrowserWindow used for rendering */
  readonly renderWindow: BrowserWindow;
  /** The preview BrowserWindow, if open */
  readonly previewWindow: BrowserWindow | null;

  /** Whether the bridge has been disposed */
  readonly isDisposed: boolean;

  /** Tear down all resources */
  dispose(): void;
}
