// Preview strip preload — the production-shaped way to receive
// `forwardPreviewFrames`: contextIsolation stays on, this preload receives
// each frame via `consumePreviewFrames(ipcRenderer)` and hands the RGBA bytes
// to the page with a *transfer* (no copy, no contextBridge cloning). The page
// draws them with `putImageData` (see preview-strip.html).

import { ipcRenderer } from "electron";
import { consumePreviewFrames } from "@napolab/texture-bridge-renderer/client";

consumePreviewFrames(ipcRenderer, {
  onFrame: (frame, slot) => {
    window.postMessage(
      { type: "preview-frame", slot, width: frame.width, height: frame.height, data: frame.data },
      "*",
      [frame.data.buffer],
    );
  },
  onError: (error) => {
    console.error("[preview-strip]", error);
  },
});

ipcRenderer.on("preview-strip-status", (_event, slot: unknown, text: unknown) => {
  window.postMessage({ type: "preview-status", slot, text }, "*");
});
