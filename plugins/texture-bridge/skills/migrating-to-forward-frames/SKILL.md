---
name: migrating-to-forward-frames
description: Use when replacing an existing Electron preview/monitor implementation with @napolab/texture-bridge zero-copy forwarding — capturePage polling, paint-event bitmap IPC, toBitmap/toPNG transfers, or a Syphon loopback feeding an in-app window — or when upgrading to the release that ships forwardFrames / forwardSharedTexture.
---

# Migrating to forwardFrames

## Overview

`forwardFrames` pushes a bridge's paint frames to any renderer `WebContents` as zero-copy GPU handles — full resolution, paint-rate, no readback. It replaces CPU preview paths (`capturePage` polling, bitmap IPC) with one registration per source.

**Prerequisites:** Electron 40+, and a `@napolab/texture-bridge-renderer` version that ships `TextureBridge.forwardFrames` (check `bridge.forwardFrames` exists in your installed `node_modules` types before starting; upgrade if not).

## Path A: capturePage preview → forwardFrames

Applies when sources are `TextureBridge` instances and previews poll `capturePage` (or IPC bitmaps from paint events).

**Delete:** the capture timer, the bitmap IPC channel (send + `ipcRenderer.on` + `putImageData`/`drawImage` of bitmaps), and any downscale logic — receivers draw the full-resolution `VideoFrame` scaled by canvas.

**Add (sender, main process):** one line per source:

```typescript
const forward = deck.bridge.forwardFrames(previewWindow.webContents, {
  extraArgs: [deckIndex],   // arrives verbatim as trailing onFrame args — the demux tag
});
// teardown: forward.dispose()  — idempotent; bridge.dispose() also clears it
```

The option is `extraArgs` (an array). There is no `sourceId`, `channel`, or `maxFps` option. The handle's cleanup method is `dispose()`, not `stop()` or `unsubscribe()`.

**Add (receiver):** the preview window consumes exactly like any shared-texture receiver — `installSharedTextureReceiver()` once + `consumeSharedTexture({ onFrame: (frame, deckIndex) => ... })`, both imported from `@napolab/texture-bridge-renderer/client` (the `/client` subpath — the package root exports the main-process API only), in a preload, window running `nodeIntegration: true, contextIsolation: false, sandbox: false`. Full recipe (frame cloning, coalescing, rAF, cleanup): see the receiving-shared-textures skill.

## Path B: manual paint wiring → forwardSharedTexture

Applies when you run your own offscreen window + `paint` handler (core tier) and currently copy pixels out for a monitor. Forward inside the same handler:

```typescript
import { forwardSharedTexture } from "@napolab/texture-bridge-core/electron";

win.webContents.on("paint", (e) => {          // stays sync — see below
  const texture = e.texture;
  if (!texture) return;
  try {
    void forwardSharedTexture(texture.textureInfo, monitorWC, [slot]);   // fire-and-forget
    sendTextureFromPaintEvent(sender, texture.textureInfo);              // existing Syphon/Spout send
  } finally {
    texture.release();   // exactly once, on every path
  }
});
```

`forwardSharedTexture` imports and releases its own imported texture internally (release-in-finally) — your `e.texture.release()` obligation is unchanged. It never throws synchronously; it resolves `undefined` or a `ForwardDefect` (`target-destroyed` / `import-failed` / `send-failed`) — check it if you want failure metrics, ignore it for best-effort.

Three properties of that handler are load-bearing, and adding forwarding is exactly when they get broken:

- **`try/finally`** — `sendTextureFromPaintEvent` throws on native send failure. Releasing after a bare sequence leaks one paint texture per frame from the first failure onward, until the shared-texture pool starves and paint stops.
- **Fire-and-forget, never `await`** — the primitive's import and send dispatch both run before its first `await`, so releasing in the same tick is safe. Awaiting instead pins this paint texture for a full IPC round-trip.
- **Keep the handler synchronous** — an `async` paint handler converts a send throw into an unhandled rejection.

## Contract Changes to Communicate

- **Best-effort forwarding:** forward failures do NOT appear on the bridge's `"error"` event or `frameDropped`. A dead preview window never affects the live Syphon/Spout output, and vice versa — the two paths are fully independent per frame.
- **Paint-driven cadence:** no timer. An idle source produces no preview frames (previous frame stays on screen — receivers should not clear canvases between frames, only on disconnect).
- **Dispose semantics (since v0.14.0):** `bridge.dispose()` destroys the offscreen window synchronously via `destroy()`. `disposed` listeners must not touch `bridge.renderWindow.webContents`; remove any external `bridge.renderWindow.destroy()` workarounds — a second destroy can throw.

## Migration Checklist

1. Verify library version ships `forwardFrames`; verify Electron ≥ 40.
2. Register forwards (Path A) or add the primitive to the paint handler (Path B).
3. Build the receiving preload per receiving-shared-textures skill.
4. Delete the old CPU path only after the new one renders.
5. Wire teardown: `forward.dispose()` when a preview closes or a source disconnects; dispose before destroying source windows.
6. Confirm CPU drop (the readback + IPC cost disappears; remaining cost is constant per source).

## Common Mistakes

| Mistake | Reality |
|---------|---------|
| `bridge.forwardFrames(wc, { sourceId })` / `{ channel }` / `{ maxFps }` | Only `{ extraArgs: [...] }` exists. Rate control belongs to the receiver's rAF coalescing. |
| `forward.stop()` / `subscription.unsubscribe()` | `forward.dispose()`. |
| Expecting forward failures on `bridge.on("error")` | Wrong channel. `bridge.on("forwardStatus")` (or `forwardFrames`'s `onStatus`) reports them as deduped state changes; with the primitive, read the resolved `ForwardDefect` yourself. |
| Preview window with default `webPreferences` | Shared-texture consumption needs the receiver preload setup — see receiving-shared-textures skill. |
| Calling `frame.videoFrame.close()` on the frame passed to `onFrame` | The consumer pool closes the original after your handler settles. `clone()` if you hold it; close only clones. |
| Keeping a `capturePage` fallback "just in case" | Delete it once verified — a hidden 30fps readback timer defeats the migration. |
