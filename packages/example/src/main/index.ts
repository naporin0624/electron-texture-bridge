/**
 * Electron Main Process - GPU Zero-Copy Texture Bridge
 *
 * Uses @napolab/texture-bridge-renderer to handle all boilerplate:
 * offscreen window, paint events, Syphon/Spout sender, and preview.
 */

import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import path from "path";
import { pathToFileURL } from "node:url";
import { createTextureBridge, createSharedTextureReceiver } from "@napolab/texture-bridge-renderer";
import { listSenders } from "@napolab/texture-bridge";
import type { TextureBridge } from "@napolab/texture-bridge-renderer";

/** Source descriptor for a multiviewer slot — mirrored structurally over IPC (no shared type import). */
type SlotSourceDescriptor = { kind: "local"; id: string } | { kind: "syphon"; senderName: string };

// GPU acceleration flags
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");
app.commandLine.appendSwitch("force-device-scale-factor", "1");

// Hoisted so the `before-quit` handler below (registered outside the
// `app.whenReady()` closure) can tear the bridge down deterministically —
// mirrors the `activeReceiver` null-guard pattern used for the receiver.
let activeBridge: TextureBridge | null = null;
// Same rationale as `activeBridge` — the three `Grid-Demo-*` multiviewer
// demo sources must be disposed on `before-quit` too.
let activeDemoBridges: TextureBridge[] = [];

const getRendererUrl = (): string => {
  if (process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}/index.html`;
  }
  return path.join(__dirname, "../renderer/index.html");
};

// `createTextureBridge` loads `rendererUrl` via `loadURL` only when it starts
// with http(s):// or file:// — anything else goes through `loadFile`, which
// treats the whole string as an OS path and cannot carry a `?hue=` query.
// So unlike `getRendererUrl` (used with an external loadURL/loadFile branch),
// this base is always URL-scheme-prefixed so bridges can append `?hue=<n>`.
const getGridDemoBase = (): string => {
  if (process.env.ELECTRON_RENDERER_URL) {
    return process.env.ELECTRON_RENDERER_URL;
  }
  return pathToFileURL(path.join(__dirname, "../renderer")).href;
};

const bootstrap = async (): Promise<void> => {
  console.log("[example] app ready");
  console.log(`[example] Electron: ${process.versions.electron}`);

  // Multiviewer-only mode skips the main 4K raymarching bridge and the
  // receiver-test window entirely, keeping only the 3 lightweight
  // Grid-Demo bridges and the multiviewer window — a fast way to iterate
  // on the multiviewer UI without paying for the heavy VJ renderer.
  const multiviewerOnly = process.env.MULTIVIEWER_ONLY === "1";
  if (multiviewerOnly) {
    console.log("[example] multiviewer-only mode");
  }

  globalShortcut.register("F12", () => {
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused) return;
    focused.webContents.toggleDevTools();
  });

  const localBridges = new Map<string, { label: string; bridge: TextureBridge }>();

  if (!multiviewerOnly) {
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
    activeBridge = bridge;

    bridge.on("fps", (fps) => {
      console.log(`[example] FPS: ${fps.toFixed(1)}`);
    });

    bridge.on("error", (err) => {
      console.error("[example] bridge error:", err.message);
    });

    bridge.on("frameDropped", (defect) => {
      console.warn(`[bridge] frame dropped: ${defect.reason}`);
    });

    bridge.renderWindow.webContents.on("did-fail-load", (_event, errorCode, errorDesc) => {
      console.error("[example] did-fail-load:", errorCode, errorDesc);
    });

    localBridges.set("ElectronVJ-ThreeJS", { label: "ElectronVJ-ThreeJS", bridge });
  }

  // ---- Multiviewer Demo Sources ----
  //
  // Three lightweight, distinct-per-hue bridges that exist purely to give
  // the multiviewer window local sources to forward via `forwardFrames`
  // (the zero-copy renderer→renderer path this feature adds), without
  // depending on an external Syphon/Spout sender being available. No preview
  // window — these are only ever consumed by the multiviewer. Always created
  // (including multiviewer-only mode) since they are the multiviewer's
  // self-contained sources.
  const gridDemoBase = getGridDemoBase();

  const gridDemoDefs = [
    { name: "Grid-Demo-A", hue: 0 },
    { name: "Grid-Demo-B", hue: 120 },
    { name: "Grid-Demo-C", hue: 240 },
  ];

  // Each demo source is independent decoration for the multiviewer — one
  // failing to construct (e.g. a transient renderer load failure) must not
  // abort bootstrap and take the whole app down with it. Per-bridge
  // try/catch: log and skip the failed demo, keep creating the rest.
  for (const demoDef of gridDemoDefs) {
    try {
      const demoBridge = await createTextureBridge({
        name: demoDef.name,
        width: 960,
        height: 540,
        frameRate: 30,
        rendererUrl: `${gridDemoBase}/grid-demo.html?hue=${demoDef.hue}`,
      });
      demoBridge.on("error", (err) => {
        console.error(`[example] ${demoDef.name} bridge error:`, err.message);
      });
      activeDemoBridges = [...activeDemoBridges, demoBridge];
      localBridges.set(demoDef.name, { label: demoDef.name, bridge: demoBridge });
    } catch (err) {
      console.error(`[example] ${demoDef.name} bridge failed to start:`, err);
    }
  }

  // ---- Receiver Test Window (zero-copy GPU path) ----
  //
  // Skipped entirely in multiviewer-only mode — it exists to smoke-test the
  // standalone Syphon/Spout receive path, which the multiviewer's own
  // "syphon" slot route already exercises.
  if (!multiviewerOnly) {
    // We drive the receiver via `createSharedTextureReceiver`, which polls
    // `receiveSharedTexture` (NT HANDLE / IOSurface) and delivers the imported
    // texture to the receiver window's renderer via Electron's
    // `sharedTexture.sendSharedTexture`. The renderer consumes each frame as a
    // `VideoFrame` and draws it via `drawImage`, which hits the GPU path
    // without any CPU readback or IPC pixel copy.
    type SharedTextureReceiver = ReturnType<typeof createSharedTextureReceiver>;
    let activeReceiver: SharedTextureReceiver | null = null;

    const stopActiveReceiver = (): void => {
      if (!activeReceiver) return;
      activeReceiver.dispose();
      activeReceiver = null;
    };

    // Receiver window needs `nodeIntegration: true` + `contextIsolation: false`
    // so the bundled renderer module can import
    // `@napolab/texture-bridge-renderer/client` and call
    // `bindSharedTextureReceiver(sharedTexture)` / `.consume()` directly. This is
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
      activeReceiver = receiver;
    });

    ipcMain.handle("set-flip-y", (_event, flipY: boolean) => {
      if (!activeReceiver) return;
      activeReceiver.setFlipY(flipY);
      console.log(`[receiver-test] live toggle flipY=${flipY}`);
    });

    ipcMain.handle("disconnect-receiver", () => {
      if (activeReceiver) {
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
  }

  // ---- Multiviewer Window (multi-source shared-texture forwarding) ----
  //
  // Same rationale as the receiver window: `nodeIntegration: true` +
  // `contextIsolation: false` lets the bundled renderer module import
  // `@napolab/texture-bridge-renderer/client` and call
  // `bindSharedTextureReceiver(sharedTexture)` / `.consume()` directly. This is
  // acceptable for an in-repo demo; production apps should keep isolation on
  // and forward frames via a preload bridge.
  const multiviewerWindow = new BrowserWindow({
    // Measured content width: the decks grid is 968px (2 × 480px + 8px gap)
    // and the composite section is 962px (960px canvas + 2px border) — the
    // wider of the two, plus the body's 12px horizontal padding on each
    // side (see multiviewer.html), is 992px. useContentSize: true sizes the
    // window by content area (excluding chrome), so 1000 leaves headroom
    // without clipping either section.
    //
    // Full content height measures ~1348px — taller than most laptop
    // displays, so height is intentionally NOT grown to match. 1000 fits
    // the deck grid plus a good part of the (CSS-display-scaled, see
    // multiviewer.html #composite) composite preview on a typical display;
    // the remainder is reachable via the body's overflow-y: auto scroll.
    useContentSize: true,
    width: 1000,
    height: 1000,
    title: "Multiviewer",
    webPreferences: {
      preload: path.join(__dirname, "../preload/multiviewer.js"),
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const multiviewerUrl = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/multiviewer.html`
    : path.join(__dirname, "../renderer/multiviewer.html");
  if (multiviewerUrl.startsWith("http")) {
    multiviewerWindow.loadURL(multiviewerUrl);
  } else {
    multiviewerWindow.loadFile(multiviewerUrl);
  }

  // `kind` categorizes the push so the renderer can keep durable connection
  // state ("state": connected/disconnected/error) separate from ephemeral
  // per-tick numbers ("metric": fps) instead of one clobbering the other.
  const sendSlotStatus = (slot: number, kind: "state" | "metric", text: string): void => {
    if (multiviewerWindow.isDestroyed()) return;
    multiviewerWindow.webContents.send("multi-slot-status", slot, kind, text);
  };

  // Each slot holds whichever `dispose()`-able handle is currently feeding
  // it — a `FrameForward` (local route) or a `SharedTextureReceiverBridge`
  // (Syphon route) — wrapped behind a common shape so `multi-connect` /
  // `multi-disconnect` don't need to know which route is active.
  const slots = new Map<number, { dispose(): void }>();

  const disposeSlot = (slot: number): void => {
    const existing = slots.get(slot);
    if (!existing) return;
    existing.dispose();
    slots.delete(slot);
  };

  // Shared by the window "closed" handler and the reload/crash teardown
  // paths below — every path that ends the multiviewer window's current
  // session must release every slot's forward/receiver handle the same way.
  const disposeAllSlots = (): void => {
    for (const slot of slots.keys()) {
      disposeSlot(slot);
    }
  };

  ipcMain.handle("multi-list-sources", () => {
    const local = Array.from(localBridges, ([id, entry]) => ({ id, label: entry.label }));
    try {
      return { local, syphon: listSenders() };
    } catch (err) {
      console.error("[multiviewer] listSenders error:", err);
      return { local, syphon: [] };
    }
  });

  ipcMain.handle(
    "multi-connect",
    (_event, slot: number, source: SlotSourceDescriptor, flipY: boolean) => {
      // `slot` and `source` arrive over IPC from the renderer — untyped at
      // the wire, so a stray/forged value must fail loudly here rather than
      // silently corrupting `slots` (e.g. a NaN/negative/out-of-range slot
      // key that `disposeSlot`/`sendSlotStatus` would never look up again).
      if (!Number.isInteger(slot) || slot < 0 || slot > 3) {
        throw new Error(`invalid slot: ${slot}`);
      }
      disposeSlot(slot);

      switch (source.kind) {
        case "local": {
          const entry = localBridges.get(source.id);
          if (!entry) {
            // Throw (not a soft-fail push) so the `ipcMain.handle` promise
            // rejects. The renderer's connect-button handler is optimistic —
            // it marks the slot connected once the invoke resolves — so a
            // soft-fail push here previously still let that success path
            // run, showing a false "connected: ..." and locking the buttons
            // into connected appearance. Rejecting routes it into the
            // existing catch, which sets an `error: ...` state and leaves
            // the buttons in disconnected state.
            throw new Error(`unknown local source: ${source.id}`);
          }
          const forward = entry.bridge.forwardFrames(multiviewerWindow.webContents, {
            extraArgs: [slot],
          });
          slots.set(slot, { dispose: () => forward.dispose() });
          sendSlotStatus(slot, "state", `connected: local (${source.id})`);
          return;
        }
        case "syphon": {
          const receiver = createSharedTextureReceiver({
            senderName: source.senderName,
            target: multiviewerWindow.webContents,
            extraArgs: [slot],
            pollIntervalMs: 8,
            flipY,
          });
          receiver.on("fps", (fps) => {
            sendSlotStatus(slot, "metric", `fps: ${fps.toFixed(1)}`);
          });
          receiver.on("error", (err) => {
            sendSlotStatus(slot, "state", `error: ${err.message}`);
          });
          receiver.start();
          slots.set(slot, { dispose: () => receiver.dispose() });
          sendSlotStatus(slot, "state", `connected: syphon (${source.senderName})`);
          return;
        }
        default:
          // `source` crossed the IPC boundary as an unvalidated value — the
          // switch is exhaustive over `SlotSourceDescriptor` so TS narrows
          // this branch to `never` (no `.kind` to read), but a forged or
          // future-version descriptor can still reach here at runtime.
          throw new Error(`unknown source kind`);
      }
    },
  );

  ipcMain.handle("multi-disconnect", (_event, slot: number) => {
    disposeSlot(slot);
    sendSlotStatus(slot, "state", "disconnected");
  });

  // Cmd+R (or any in-page navigation) reloads the renderer, which resets its
  // preload state to "disconnected" — but the main-side slots/forwards keep
  // running against the pre-reload webContents, feeding frames the reloaded
  // page never asked for. `render-process-gone` (renderer crash) leaves the
  // same kind of orphaned state. Both need the same teardown as a real
  // window close.
  multiviewerWindow.webContents.on("did-navigate", disposeAllSlots);
  multiviewerWindow.webContents.on("render-process-gone", disposeAllSlots);

  multiviewerWindow.on("closed", () => {
    disposeAllSlots();
    ipcMain.removeHandler("multi-list-sources");
    ipcMain.removeHandler("multi-connect");
    ipcMain.removeHandler("multi-disconnect");

    // In MULTIVIEWER_ONLY mode this is the only visible window — the three
    // Grid-Demo bridges each own a hidden `show: false` offscreen
    // BrowserWindow that stays alive and keeps Electron from ever seeing
    // "all windows closed", so the app would otherwise become an invisible
    // zombie process once this window closes.
    if (multiviewerOnly) {
      app.quit();
    }
  });
};

void app
  .whenReady()
  .then(bootstrap)
  .catch((err: unknown) => {
    console.error("[example] bootstrap failed:", err);
  });

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  if (activeBridge) {
    activeBridge.dispose();
    activeBridge = null;
  }
  for (const demoBridge of activeDemoBridges) {
    demoBridge.dispose();
  }
  activeDemoBridges = [];
});
