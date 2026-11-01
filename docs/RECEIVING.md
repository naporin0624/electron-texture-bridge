# Receiving textures from Spout/Syphon

There are two receive paths, and they solve different problems:

- **`TextureReceiver.receiveFrame()` / `createTextureReceiver()`** — RGBA readback. The native side performs a GPU→CPU blit (D3D11 staging / Metal blit), then hands you an `ArrayBuffer` via an IPC hop. Roughly ~8 MB per 1080p frame copied through IPC. Use it when you actually want pixel data in JavaScript (analysis, image export, custom color pipelines).
- **`TextureReceiver.receiveSharedTexture()` / `createSharedTextureReceiver()` / `bindSharedTextureReceiver()`** — zero-copy GPU delivery. The native side mints a platform-native shared handle (DXGI NT handle on Windows, IOSurface pointer on macOS) per frame and passes it through Electron's `sharedTexture.importSharedTexture` + `sendSharedTexture` pair into the renderer as a `VideoFrame`. No CPU readback, no ArrayBuffer IPC copy. `ctx.drawImage(videoFrame, 0, 0)` stays on the GPU and `GPUDevice.importExternalTexture({ source: videoFrame })` exposes the same texture to WebGPU without a copy. Use it when you just want to display or GPU-process the incoming video.

Pick whichever matches what you will do with the frame.

> **Status.** The zero-copy GPU path is verified end-to-end on both Windows (Spout) and macOS (Syphon Metal). On macOS the receiver mints a fresh per-frame `IOSurfaceRef` backed by a per-receiver staging `MTLTexture` and Y-flips it through a tiny render pass so `drawImage(videoFrame)` / `importExternalTexture({ source: videoFrame })` render right-side-up. The same `closeNativeHandle()` ownership contract (below) applies on both platforms.

## Main process: `createSharedTextureReceiver`

```typescript
// main process
import { app, BrowserWindow } from "electron";
import { createSharedTextureReceiver } from "@napolab/texture-bridge-renderer";

app.whenReady().then(() => {
  const receiverWindow = new BrowserWindow({
    width: 960,
    height: 540,
    webPreferences: {
      preload: /* path to preload that installs the consumer */ undefined,
    },
  });

  const bridge = createSharedTextureReceiver({
    senderName: "Resolume Arena",   // required
    target: receiverWindow.webContents,
    mode: "push",                   // optional, "push" (default on macOS/Windows) | "poll"
    pollIntervalMs: 8,              // optional, poll mode only, defaults to 16
    appName: undefined,             // optional, macOS filter
    serverUuid: undefined,          // optional, macOS UUID
    extraArgs: [],                  // optional, forwarded to sendSharedTexture(..., ...args)
  });

  bridge.on("fps", (fps) => console.log(`[receiver] ${fps.toFixed(1)} fps`));
  bridge.on("error", (err) => console.error("[receiver]", err.message));
  bridge.on("disposed", () => console.log("[receiver] disposed"));

  bridge.start();

  receiverWindow.on("closed", () => {
    bridge.dispose();   // stops polling, releases the native receiver, emits "disposed"
  });
});
```

The bridge runs with a drop-latest policy: if a previous `sendSharedTexture` is still in flight when the next poll fires, the tick is skipped. This keeps at most one imported-texture reference alive on the main process and prevents frame pile-up when the renderer is slow.

### Push mode and the staging ring

In `mode: "push"` (the default on macOS / Windows) the native side stages each new sender frame into one of 3 receiver-owned GPU slots and calls back with that slot's handle; while a send is in flight the bridge keeps only the newest pushed frame (latest-wins). The bridge closes every handle right after `importSharedTexture` returns — Electron keeps its own reference — so a slot's "still held downstream" check cannot rely on the caller's handle:

- **macOS:** a slot is skipped while its `IOSurfaceRef` is retained beyond the ring's own reference **or** `IOSurfaceIsInUse` reports it in use. Electron's import does not show up in `CFGetRetainCount`, so in practice `IOSurfaceIsInUse` is what protects a slot the renderer is still sampling. When all 3 slots are in use the frame is dropped natively (logged as "all 3 ring slots still held downstream").
- **Windows:** a slot counts as held only while the NT handle handed out for it is still open (`CompareObjectHandles`). Because the bridge closes it right after import, the check effectively always sees the slot free, so the ring degrades to round-robin over its 3 slots — it cannot detect a slot the renderer still holds. That is still strictly better than the single staging texture the poll path reuses every frame. On Windows older than 10 1607 (no `CompareObjectHandles`) a handed-out slot is treated as held forever, so push delivery stops after 3 frames; use `mode: "poll"` there.

## Renderer process: `bindSharedTextureReceiver` + `receiver.consume`

```typescript
// renderer process (or preload with nodeIntegration: true, contextIsolation: false)
import { sharedTexture } from "electron";
import { bindSharedTextureReceiver } from "@napolab/texture-bridge-renderer/client";

// Call once at startup. Binds Electron's single
// sharedTexture.setSharedTextureReceiver slot to a pool so multiple consumers
// can coexist. Binding the same sharedTexture twice (without dispose) throws
// SharedTextureReceiverAlreadyBoundError.
const receiver = bindSharedTextureReceiver(sharedTexture);

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

const registration = receiver.consume({
  onFrame: ({ textureId, videoFrame }) => {
    if (canvas.width !== videoFrame.displayWidth) canvas.width = videoFrame.displayWidth;
    if (canvas.height !== videoFrame.displayHeight) canvas.height = videoFrame.displayHeight;
    // Zero-copy GPU blit in Chromium when the source is a shared-texture VideoFrame.
    ctx.drawImage(videoFrame, 0, 0);
  },
  onError: (err) => console.error("[consumer]", err),
});

// registration.dispose();  // optional — removes this consumer from the pool
// receiver.dispose();      // optional — tears the binding down (idempotent)
```

`videoFrame` is a standard Web `VideoFrame`. For WebGPU, hand it to `device.importExternalTexture({ source: videoFrame })` instead of `drawImage` — that path is also zero-copy. You do **not** need to call `videoFrame.close()` yourself; the consumer wrapper closes it after your handler's returned promise settles.

`receiver.dispose()` drops every consumer and lets the same `sharedTexture` be bound again; calling `receiver.consume()` after that throws `SharedTextureReceiverDisposedError`. Electron has no way to unset the receiver slot, so the installed callback keeps draining and releasing frames that still arrive. See [API Reference](API.md#bindsharedtexturereceiversharedtexture-from-rendererclient) for details.

## Optional: polling `TextureReceiver.receiveSharedTexture()` directly

If you want to drive the poll loop yourself (e.g. to integrate with a custom scheduler), use the low-level primitive and forward the handle to `sharedTexture.importSharedTexture` by hand:

```typescript
import { TextureReceiver, closeNativeHandle } from "@napolab/texture-bridge";
import { sharedTexture } from "electron";

const receiver = new TextureReceiver("Resolume Arena");
const frame = receiver.receiveSharedTexture();
if (frame) {
  const handle =
    process.platform === "win32" ? { ntHandle: frame.handle } : { ioSurface: frame.handle };
  try {
    const imported = sharedTexture.importSharedTexture({
      textureInfo: {
        codedSize: { width: frame.width, height: frame.height },
        handle,
        pixelFormat: frame.pixelFormat,   // "bgra" | "rgba" | "rgbaf16"
      },
    });
    // ... deliver `imported` via sendSharedTexture, then imported.release() ...
  } finally {
    // importSharedTexture never adopts the handle (it keeps its own
    // duplicated / retained reference), so release ours whether the import
    // succeeded or threw.
    closeNativeHandle(frame.handle);
  }
}
```

> **Ownership contract.** Every `SharedTextureFrame.handle` returned by `receiveSharedTexture()` is a freshly-minted native handle that you own, and you **must** pass it to `closeNativeHandle(frame.handle)` exactly once — on **every** path, including a successful `importSharedTexture`. Electron never takes ownership of the handle: `importSharedTexture` `DuplicateHandle`s the NT handle (Windows) / retains the `IOSurfaceRef` (macOS) into its own reference, which it drops when the imported texture is released. So it is safe to close right after the import call returns, success or throw — the `finally` above. Paths that never import (unknown pixel format, target destroyed, you decided to skip the frame) close it too. Skipping the close leaks one NT HANDLE (Windows) / `IOSurfaceRef` retain (macOS) per frame. `createSharedTextureReceiver` does all of this for you.

## Discovering available senders

```typescript
import { listSenders } from "@napolab/texture-bridge-renderer";

for (const s of listSenders()) {
  console.log(s.name, s.appName ?? "", s.uuid ?? "");
}
// [{ name: "Resolume Arena", appName: "Resolume Arena", uuid: "..." }, ...]
```

For continuous change notifications, use `SenderDiscovery` (see [API Reference](API.md#senderdiscovery)).

## Renderer context isolation

Electron's `sharedTexture` module is only accessible from the main and renderer processes that have `electron` resolvable at runtime. Importing `@napolab/texture-bridge-renderer/client` directly from a Vite-driven renderer can fail during dev pre-bundle (`path.join is not a function`), because Vite cannot pre-bundle the `electron` CJS module. Two ways out:

1. **Recommended for simple cases:** put `bindSharedTextureReceiver(sharedTexture)` and `receiver.consume()` in a **preload script** (bundled by electron-vite / electron-builder with `externalizeDepsPlugin`), and run the receiver window with `nodeIntegration: true, contextIsolation: false`. The example app does this — see [`packages/example/src/preload/receiver.ts`](../packages/example/src/preload/receiver.ts).
2. **Context-isolated setups:** bind the consumer in the preload, then forward each `VideoFrame` to the isolated renderer world via `window.postMessage(videoFrame, "*", [videoFrame])` (the `VideoFrame` is a transferable). Close it on the renderer side after use.

