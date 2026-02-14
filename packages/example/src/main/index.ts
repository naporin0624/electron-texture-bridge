/**
 * Electron Main Process - GPU Zero-Copy Texture Bridge
 *
 * Uses @napolab/texture-bridge-renderer to handle all boilerplate:
 * offscreen window, paint events, Syphon/Spout sender, and preview.
 */

import { app, BrowserWindow, globalShortcut } from "electron";
import path from "path";
import { createTextureBridge } from "@napolab/texture-bridge-renderer";

// GPU acceleration flags
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");
app.commandLine.appendSwitch("force-device-scale-factor", "1");

function getRendererUrl(): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}/index.html`;
  }
  return path.join(__dirname, "../renderer/index.html");
}

app.whenReady().then(async () => {
  console.log("[example] app ready");
  console.log(`[example] Electron: ${process.versions.electron}`);

  globalShortcut.register("F12", () => {
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused) return;
    focused.webContents.toggleDevTools();
  });

  const bridge = await createTextureBridge({
    name: "ElectronVJ-ThreeJS",
    width: 1920,
    height: 1080,
    frameRate: 120,
    rendererUrl: getRendererUrl(),
    preview: { enabled: true, width: 960, height: 540 },
  });

  bridge.on("fps", (fps) => {
    console.log(`[example] FPS: ${fps.toFixed(1)}`);
  });

  bridge.on("error", (err) => {
    console.error("[example] bridge error:", err.message);
  });

  bridge.renderWindow.webContents.on("did-fail-load", (_event, errorCode, errorDesc) => {
    console.error("[example] did-fail-load:", errorCode, errorDesc);
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
});
