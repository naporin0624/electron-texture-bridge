// Zero-copy receiver window bootstrap.
//
// The receiver BrowserWindow runs with `nodeIntegration: true,
// contextIsolation: false`, so this preload script lives in the same global
// scope as the HTML's DOM. We centralize all renderer logic here because
// Vite's dev server (driving the renderer) cannot pre-bundle the `electron`
// CJS module, whereas preload scripts are bundled by electron-vite with
// `externalizeDepsPlugin` and resolve `electron` at runtime.

import { ipcRenderer } from "electron";
import {
  installSharedTextureReceiver,
  consumeSharedTexture,
} from "@napolab/texture-bridge-renderer/client";

installSharedTextureReceiver();

type SenderEntry = { name: string; appName?: string };

interface ReceiverUI {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  info: HTMLDivElement;
  senderList: HTMLSelectElement;
  refreshBtn: HTMLButtonElement;
  connectBtn: HTMLButtonElement;
  disconnectBtn: HTMLButtonElement;
  flipYCheckbox: HTMLInputElement;
}

const state = {
  connected: false,
  currentSenderName: "",
  frameCount: 0,
  lastFpsTime: 0,
  renderFps: 0,
  mainFps: 0,
};

let ui: ReceiverUI | null = null;

const formatInfo = () => {
  if (!ui) return;
  ui.info.textContent =
    `${ui.canvas.width}x${ui.canvas.height} | render ${state.renderFps.toFixed(1)} fps | ` +
    `receiver ${state.mainFps.toFixed(1)} fps` +
    (state.currentSenderName ? ` | "${state.currentSenderName}"` : "");
};

// Start the consumer pool immediately. onFrame becomes a no-op until the DOM
// is ready and we've cached the canvas. No rAF gating: the main-side bridge
// runs with drop-latest (`_inFlight`), so each delivered frame is already
// the latest available. Awaiting rAF inside onFrame would only add one
// vsync of latency without reducing GPU work.
consumeSharedTexture({
  onFrame: ({ videoFrame }) => {
    if (!ui) return;
    if (
      ui.canvas.width !== videoFrame.displayWidth ||
      ui.canvas.height !== videoFrame.displayHeight
    ) {
      ui.canvas.width = videoFrame.displayWidth;
      ui.canvas.height = videoFrame.displayHeight;
    }
    // drawImage(VideoFrame) is a zero-copy GPU blit in Chromium when the
    // source is a GPU-backed imported shared texture (produced by
    // `importSharedTexture`). No CPU readback, no IPC pixel copy.
    ui.ctx.drawImage(videoFrame, 0, 0);

    state.frameCount += 1;
    const now = performance.now();
    if (now - state.lastFpsTime >= 1000) {
      state.renderFps = (state.frameCount * 1000) / (now - state.lastFpsTime);
      state.frameCount = 0;
      state.lastFpsTime = now;
      formatInfo();
    }
  },
  onError: (err) => {
    console.error("[receiver-test] consume error:", err);
  },
});

ipcRenderer.on("receiver-fps", (_event, fps: number) => {
  state.mainFps = fps;
  formatInfo();
});

const refreshSenders = async (): Promise<void> => {
  if (!ui) return;
  const senders: SenderEntry[] = await ipcRenderer.invoke("list-senders");
  ui.senderList.innerHTML = '<option value="">-- Select Sender --</option>';
  for (const s of senders) {
    const opt = document.createElement("option");
    const label = s.appName ? `${s.name} (${s.appName})` : s.name;
    opt.value = s.name;
    opt.textContent = label;
    ui.senderList.appendChild(opt);
  }
};

const getElement = <T extends HTMLElement>(id: string, ctor: new () => T): T | null => {
  const element = document.getElementById(id);
  return element instanceof ctor ? element : null;
};

window.addEventListener("DOMContentLoaded", () => {
  const canvas = getElement("canvas", HTMLCanvasElement);
  const ctx = canvas?.getContext("2d");
  const info = getElement("info", HTMLDivElement);
  const senderList = getElement("senderList", HTMLSelectElement);
  const refreshBtn = getElement("refreshBtn", HTMLButtonElement);
  const connectBtn = getElement("connectBtn", HTMLButtonElement);
  const disconnectBtn = getElement("disconnectBtn", HTMLButtonElement);
  const flipYCheckbox = getElement("flipYCheckbox", HTMLInputElement);

  if (
    !canvas ||
    !ctx ||
    !info ||
    !senderList ||
    !refreshBtn ||
    !connectBtn ||
    !disconnectBtn ||
    !flipYCheckbox
  ) {
    console.error("[receiver-test] required DOM elements missing");
    return;
  }

  ui = {
    canvas,
    ctx,
    info,
    senderList,
    refreshBtn,
    connectBtn,
    disconnectBtn,
    flipYCheckbox,
  };
  state.lastFpsTime = performance.now();

  senderList.addEventListener("change", () => {
    connectBtn.disabled = !senderList.value || state.connected;
  });

  refreshBtn.addEventListener("click", () => {
    void refreshSenders();
  });

  // Live-toggle the native flipY flag so the checkbox affects the running
  // receiver immediately without a reconnect. When disconnected, the checkbox
  // just sets the initial value used at the next connect.
  flipYCheckbox.addEventListener("change", () => {
    if (!state.connected) return;
    void ipcRenderer.invoke("set-flip-y", flipYCheckbox.checked);
  });

  connectBtn.addEventListener("click", async () => {
    const name = senderList.value;
    if (!name) return;
    state.currentSenderName = name;
    info.textContent = `Connecting to "${name}"...`;
    try {
      await ipcRenderer.invoke("connect-receiver", name, flipYCheckbox.checked);
      state.connected = true;
      connectBtn.disabled = true;
      disconnectBtn.disabled = false;
      senderList.disabled = true;
      formatInfo();
    } catch (err) {
      info.textContent = `Error: ${err instanceof Error ? err.message : `${err}`}`;
    }
  });

  disconnectBtn.addEventListener("click", async () => {
    await ipcRenderer.invoke("disconnect-receiver");
    state.connected = false;
    state.currentSenderName = "";
    connectBtn.disabled = !senderList.value;
    disconnectBtn.disabled = true;
    senderList.disabled = false;
    info.textContent = "Disconnected";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });

  void refreshSenders();
});
