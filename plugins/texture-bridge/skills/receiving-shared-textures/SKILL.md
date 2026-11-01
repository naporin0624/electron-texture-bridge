---
name: receiving-shared-textures
description: Use when implementing the receiving side of @napolab/texture-bridge shared-texture frames in an Electron renderer — consuming forwardFrames/forwardSharedTexture output, displaying createSharedTextureReceiver frames, building a multiviewer/preview grid, or debugging leaked VideoFrames, black canvases, or frames from a disconnected source reappearing.
---

# Receiving Shared Textures

## Overview

Every shared-texture producer in `@napolab/texture-bridge` — `bridge.forwardFrames`, `forwardSharedTexture`, `createSharedTextureReceiver` — delivers to a renderer through the same consuming pair:

```typescript
import { sharedTexture } from "electron";
import { bindSharedTextureReceiver } from "@napolab/texture-bridge-renderer/client";   // the /client subpath — not the package root

const receiver = bindSharedTextureReceiver(sharedTexture);
const sub = receiver.consume({ onFrame: (frame, ...extraArgs) => { /* ... */ }, onError });
```

`bindSharedTextureReceiver(sharedTexture)` — once at startup, before any consume call. It binds Electron's **single** `sharedTexture.setSharedTextureReceiver` slot to a pool so multiple consumers coexist; that bind is its only side effect. It returns a handle: `receiver.consume(handlers)` registers a consumer and returns `{ dispose() }`; `receiver.dispose()` (idempotent) empties the pool and frees the target. Never call `sharedTexture.setSharedTextureReceiver` yourself alongside it.

- Binding the same `sharedTexture` twice without disposing throws `SharedTextureReceiverAlreadyBoundError`. Keep one binding per window and share the handle; re-binding is allowed after `receiver.dispose()`.
- `receiver.consume()` after `receiver.dispose()` throws `SharedTextureReceiverDisposedError`.
- Electron has no unset: after `receiver.dispose()` the installed callback stays and keeps draining (releasing) frames that still arrive.

## Window Setup

The consuming code must run where `electron` is resolvable — a **preload script**, with:

```typescript
new BrowserWindow({
  webPreferences: {
    preload: path.join(__dirname, "../preload/monitor.js"),
    nodeIntegration: true,
    contextIsolation: false,
    sandbox: false,
  },
});
```

Importing `/client` from a Vite-driven renderer page fails in dev (Vite cannot pre-bundle the `electron` CJS module) — keep it in the preload. For context-isolated production setups: consume in the preload, then `window.postMessage(videoFrame, "*", [videoFrame])` each frame into the isolated world (`VideoFrame` is transferable; the receiving side closes it).

## The Frame Lifecycle Contract

This is where implementations go wrong:

1. `onFrame(frame, ...extraArgs)` receives `{ textureId, videoFrame }`. The `extraArgs` are whatever the producer passed (`forwardFrames`' demux tag, etc.).
2. **The pool closes `frame.videoFrame` after your handler settles.** Do not close it yourself. There is no `frame.release()` — that's the sender-side paint-event API.
3. **To use a frame beyond the handler, `clone()` it.** Close every clone you make, exactly once: when replaced by a newer frame, on disconnect, and on `beforeunload`.

## Canonical Recipe: N-source Monitor Grid

Latest-frame coalescing + rAF draw. Draw cost stays fixed at display refresh rate no matter how many sources or how fast they paint; decks keep showing the last frame between arrivals instead of flickering.

```typescript
// preload/monitor.ts
import { sharedTexture } from "electron";
import { bindSharedTextureReceiver } from "@napolab/texture-bridge-renderer/client";
import type { SharedTextureConsumerFrame } from "@napolab/texture-bridge-renderer/client";

const receiver = bindSharedTextureReceiver(sharedTexture);

const SLOT_COUNT = 4;
const W = 480, H = 270;

// One held clone per slot; undefined = nothing to draw.
const latest: (SharedTextureConsumerFrame | undefined)[] = Array.from({ length: SLOT_COUNT });
// dispose() doesn't cancel deliveries already in flight, so a stray tagged
// frame can arrive just after disconnect — this guard drops it instead of
// letting it resurrect the slot.
const connected: boolean[] = Array.from({ length: SLOT_COUNT }, () => false);

receiver.consume({
  onFrame: (frame, ...args) => {
    const slot = args[0];
    if (typeof slot !== "number" || slot < 0 || slot >= SLOT_COUNT) return;
    if (!connected[slot]) return;
    const held = frame.videoFrame.clone();                 // clone FIRST…
    latest[slot]?.videoFrame.close();                      // …then close the superseded one
    latest[slot] = { textureId: frame.textureId, videoFrame: held };
  },
  onError: (err) => console.error("[monitor]", err),
});

const draw = (): void => {
  try {
    for (const [slot, held] of latest.entries()) {
      if (!held) continue;
      const deckCtx = deckContexts[slot];
      deckCtx?.drawImage(held.videoFrame, 0, 0, W, H);     // GPU blit; draw scales full-res frame
      // 2x2 composite = renderer-side atlas: blit each held frame into its quadrant
      compositeCtx.drawImage(held.videoFrame, (slot % 2) * W, Math.floor(slot / 2) * H, W, H);
      // do NOT close here — the held clone is redrawn every tick until replaced
    }
  } finally {
    requestAnimationFrame(draw);   // re-arm in finally: one throw must not end the loop
  }
};
requestAnimationFrame(draw);

const disconnectSlot = (slot: number): void => {
  connected[slot] = false;                                  // before disposing the producer
  latest[slot]?.videoFrame.close();
  latest[slot] = undefined;
  deckContexts[slot]?.clearRect(0, 0, W, H);
  compositeCtx.clearRect((slot % 2) * W, Math.floor(slot / 2) * H, W, H);  // clear the quadrant too
};

window.addEventListener("beforeunload", () => {
  receiver.dispose();
  for (const held of latest) held?.videoFrame.close();
});
```

Main-process side per slot: `bridge.forwardFrames(monitorWC, { extraArgs: [slot] })` (local source) or `createSharedTextureReceiver({ senderName, target: monitorWC, extraArgs: [slot] })` + `.start()` (external Syphon/Spout source) — both feed this same consumer. On disconnect, `dispose()` the producer AND run `disconnectSlot`.

For WebGPU, replace `drawImage` with `device.importExternalTexture({ source: held.videoFrame })` — also zero-copy.

## Common Mistakes

| Mistake | Reality |
|---------|---------|
| `frame.videoFrame.close()` (or an invented `frame.release()`) inside `onFrame` | The pool closes the original after the handler settles. Close only your clones. |
| Drawing directly in `onFrame` | Ties draw cost to arrival rate (N sources × paint rate). Hold latest clone, draw in one rAF loop. |
| Closing the held frame after drawing it | Held clone is redrawn every tick — closing it blanks the deck until the next arrival. Close only when superseded, disconnected, or unloading. |
| Skipping the `connected` guard | In-flight frames arriving after disconnect resurrect the slot with a stale image. |
| Closing the superseded clone before `clone()` returns | If `clone()` throws you are left holding a closed frame; the next `drawImage` throws `InvalidStateError`. Clone first, then close. |
| `requestAnimationFrame(draw)` outside a `finally` | One `drawImage`/`clone` throw ends the loop for the session — every deck freezes while arrival counters keep ticking. |
| Clearing canvases between frames | Paint-driven sources go idle legitimately; clearing causes flicker. Clear only on disconnect (deck AND composite quadrant). |
| `setSharedTextureReceiver` directly, or importing `/client` in a Vite renderer page | Single-slot API conflicts with the pool; Vite dev can't pre-bundle `electron`. Preload + `bindSharedTextureReceiver(sharedTexture)`. |
| Inventing `exposeFrameReceiver` / `subscribeFrames` / `@napolab/texture-bridge/preload` | None exist. The receiving surface is exactly `bindSharedTextureReceiver(sharedTexture)` + `receiver.consume(handlers)` (+ `createMultiDispatcher` for custom fan-out adapters). The old global install-then-consume function pair was removed — a zero-argument install call or a free-standing consume function is an invented API now; always go through the `receiver` handle. |
| Calling `bindSharedTextureReceiver(sharedTexture)` in several modules of the same window | Second call throws `SharedTextureReceiverAlreadyBoundError`. Bind once, pass the handle around, and `receiver.consume()` per consumer. |
