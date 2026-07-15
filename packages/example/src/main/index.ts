/**
 * Electron Main Process - GPU Zero-Copy Texture Bridge
 *
 * Uses @napolab/texture-bridge-renderer to handle all boilerplate:
 * offscreen window, paint events, Syphon/Spout sender, and preview.
 */

import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import path from "path";
import { createTextureBridge, createSharedTextureReceiver } from "@napolab/texture-bridge-renderer";
import { listSenders } from "@napolab/texture-bridge";

// GPU acceleration flags
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");
app.commandLine.appendSwitch("force-device-scale-factor", "1");

const getRendererUrl = (): string => {
  if (process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}/index.html`;
  }
  return path.join(__dirname, "../renderer/index.html");
};

const bootstrap = async (): Promise<void> => {
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
    // Forward the page's alpha channel into the Syphon/Spout texture so
    // VJ software can use this output as an overlay layer. The renderer's
    // raymarching shader emits alpha=0 for background pixels.
    includeAlpha: true,
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

  // ---- Receiver Test Window (zero-copy GPU path) ----
  //
  // We drive the receiver via `createSharedTextureReceiver`, which polls
  // `receiveSharedTexture` (NT HANDLE / IOSurface) and delivers the imported
  // texture to the receiver window's renderer via Electron's
  // `sharedTexture.sendSharedTexture`. The renderer consumes each frame as a
  // `VideoFrame` and draws it via `drawImage`, which hits the GPU path
  // without any CPU readback or IPC pixel copy.
  type SharedTextureReceiver = ReturnType<typeof createSharedTextureReceiver>;
  /** Single mutable slot for the currently connected receiver (repo bans `let`). */
  const receiverSlot = { active: null as SharedTextureReceiver | null };

  const stopActiveReceiver = (): void => {
    if (!receiverSlot.active) return;
    receiverSlot.active.dispose();
    receiverSlot.active = null;
  };

  // Receiver window needs `nodeIntegration: true` + `contextIsolation: false`
  // so the bundled renderer module can import
  // `@napolab/texture-bridge-renderer/client` and call
  // `installSharedTextureReceiver` / `consumeSharedTexture` directly. This is
  // acceptable for an in-repo demo; production apps should keep isolation on
  // and forward frames via a preload bridge.
  const receiverWindow = new BrowserWindow({
    width: 960,
    height: 600,
    title: "Receiver Test",
    webPreferences: {
      preload: path.join(__dirname, "../preload/receiver.js"),
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const receiverUrl = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/receiver-test.html`
    : path.join(__dirname, "../renderer/receiver-test.html");
  if (receiverUrl.startsWith("http")) {
    receiverWindow.loadURL(receiverUrl);
  } else {
    receiverWindow.loadFile(receiverUrl);
  }

  ipcMain.handle("list-senders", () => {
    try {
      return listSenders();
    } catch (err) {
      console.error("[receiver-test] listSenders error:", err);
      return [];
    }
  });

  ipcMain.handle("connect-receiver", (_event, senderName: string, flipY: boolean) => {
    stopActiveReceiver();
    console.log(`[receiver-test] connecting to "${senderName}" (zero-copy, flipY=${flipY})`);

    const receiver = createSharedTextureReceiver({
      senderName,
      target: receiverWindow.webContents,
      pollIntervalMs: 8,
      flipY,
    });
    receiver.on("fps", (fps) => {
      if (!receiverWindow.isDestroyed()) {
        receiverWindow.webContents.send("receiver-fps", fps);
      }
    });
    receiver.on("error", (err) => {
      console.error("[receiver-test] bridge error:", err.message);
    });
    receiver.start();
    receiverSlot.active = receiver;
  });

  ipcMain.handle("set-flip-y", (_event, flipY: boolean) => {
    if (!receiverSlot.active) return;
    receiverSlot.active.setFlipY(flipY);
    console.log(`[receiver-test] live toggle flipY=${flipY}`);
  });

  ipcMain.handle("disconnect-receiver", () => {
    if (receiverSlot.active) {
      stopActiveReceiver();
      console.log("[receiver-test] disconnected");
    }
  });

  receiverWindow.on("closed", () => {
    stopActiveReceiver();
    ipcMain.removeHandler("list-senders");
    ipcMain.removeHandler("connect-receiver");
    ipcMain.removeHandler("set-flip-y");
    ipcMain.removeHandler("disconnect-receiver");
  });
};

void app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
});
