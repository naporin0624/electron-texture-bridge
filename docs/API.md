# API Reference

Complete reference for every exported symbol. See the [README](../README.md) for a guided introduction, [SENDING.md](SENDING.md) for sending recipes, and [RECEIVING.md](RECEIVING.md) for the receive paths.

## `@napolab/texture-bridge-renderer`

### `createTextureBridge(options): Promise<TextureBridge>`

Factory function that creates a fully-wired texture bridge. Must be called after `app.whenReady()`.

```typescript
interface TextureBridgeOptions {
  name: string;            // Syphon/Spout sender name
  width: number;           // Texture width in pixels
  height: number;          // Texture height in pixels
  frameRate?: number;      // Target frame rate (default: 60)
  rendererUrl: string;     // URL to load (file path, file://, or http://)
  preview?: PreviewOptions;
  webPreferences?: Electron.WebPreferences;
  includeAlpha?: boolean;  // Forward per-pixel alpha into the shared texture (default: false)
  pixelExact?: boolean;    // Pin the framebuffer to exactly width×height regardless of display DPR (default: false)
}

interface PreviewOptions {
  enabled?: boolean;       // Open preview window (default: false)
  width?: number;          // Preview window width
  height?: number;         // Preview window height
  title?: string;          // Preview window title
}
```

**`pixelExact`** — when `true`, the offscreen framebuffer is pinned to exactly `width × height` pixels regardless of the host display's device pixel ratio. **Electron ≥ 41:** trivially satisfied and effectively a no-op — `createTextureBridge` already pins `offscreen.deviceScaleFactor: 1`, so the framebuffer is always exact whether or not this option is set. **Electron 40:** without it, a Retina (scaleFactor 2) or Windows-scaled (150% / 175%) display produces a framebuffer larger than the declared sender size, which typically shows up as black/garbled output in the receiver (see the [Retina/DPI warning](SENDING.md#macos-retina-and-windows-dpi-scaling)). The sender is always registered at the requested pixel size, so receivers see the dimensions you asked for. Note: non-divisible scale ratios (e.g. `1920 / 1.75`) can leave a 1-pixel discrepancy, and only the primary display's scaleFactor at construction time is honored — call `resize()` to re-apply after a DPI change.

### `createTextureBridgeWith(deps)` (advanced)

```typescript
interface TextureBridgeDeps {
  createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
  createSender: (name: string, width: number, height: number) => TextureSender;
}

function createTextureBridgeWith(
  deps: TextureBridgeDeps,
): (options: TextureBridgeOptions) => Promise<TextureBridge>;
```

Returns `createTextureBridge` bound to injected constructors — lets tests and
embedders swap the `BrowserWindow` construction or the native `TextureSender`
construction with test doubles. `createTextureBridge` itself is just
`createTextureBridgeWith` bound to the real `BrowserWindow` and `TextureSender`.
The factory still calls Electron's `app` / `screen` globals directly and
constructs the preview window itself (`PreviewManager`) — this seam does not
make the factory Electron-free, only its window/sender construction is
injectable. A fully Electron-free test environment needs `app` / `screen`
mocked separately.

### `TextureBridge`

The returned handle provides:

```typescript
interface TextureBridge {
  on(event: "fps", listener: (fps: number) => void): this;
  on(event: "ready", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "frameDropped", listener: (defect: PaintDefect) => void): this;
  on(event: "forwardStatus", listener: (status: ForwardStatusEvent) => void): this;
  on(event: "resize", listener: (width: number, height: number) => void): this;
  on(event: "disposed", listener: () => void): this;

  resize(width: number, height: number): void;  // Cascades to all layers + Worker
  openPreview(): void;
  closePreview(): void;
  forwardFrames(target: WebContents, options?: FrameForwardOptions): FrameForward;
  forwardPreviewFrames(target: WebContents, options: PreviewFrameForwardOptions): FrameForward;
  dispose(): void;

  readonly renderWindow: BrowserWindow;
  readonly previewWindow: BrowserWindow | null;
  readonly isDisposed: boolean;
  readonly droppedReason: PaintDefect["reason"] | null;
}
```

`frameDropped` fires when a paint frame is dropped before reaching the sender
(`reason`: `"no-texture" | "no-nt-handle" | "no-io-surface" | "unsupported-platform"`).
It is not an error — but if it fires persistently, receivers see black output.
Consecutive drops with the same reason are deduped: the event fires once, and
again only after a successful send or a reason change. If a drop latches
before your listener is attached (e.g. while the renderer page is still
loading), read `bridge.droppedReason` — it holds the latest drop reason, or
`null` after a successful send.

`forwardStatus` reports the delivery state of each `forwardFrames`
registration — the only channel that does, since forwarding never raises
`"error"` and never touches `frameDropped` / `droppedReason`. It fires on
state *changes*, not per frame: the first successful frame, the first
failure, a change of failure reason, and the recovery back to success.

```typescript
type ForwardStatus =
  | { ok: true }
  | {
      ok: false;
      // "preview-unavailable" only for forwardPreviewFrames registrations
      reason: "target-destroyed" | "import-failed" | "send-failed" | "preview-unavailable";
      cause?: Error;
    };

type ForwardStatusEvent = ForwardStatus & { extraArgs: readonly unknown[] };
```

Which registration a status belongs to is identified by `extraArgs` — the tag
passed to `forwardFrames(target, { extraArgs })`. To scope the same
transitions to one registration instead, pass `onStatus` in the same options
object. Watch this: a forward can die while paint, sender and preview all stay
healthy, and without it the only symptom is a monitor window that quietly
stays black.

`dispose()` destroys the offscreen `renderWindow` synchronously via
`destroy()` (not `close()`), so teardown cannot lose the race against
Electron's `before-quit` and pop a crash dialog. Two things follow from that:

- **`disposed` listeners must not touch `bridge.renderWindow.webContents`** —
  the offscreen window is already destroyed by the time `disposed` fires.
- **The render window's `close` event and the page's `beforeunload`/`unload`
  handlers no longer fire** — that's `destroy()`'s documented behavior. Its
  `closed` event still fires.

The preview window is unaffected: it's a real, visible window and still
closes via `close()` with normal close semantics. If you previously worked
around the old async `close()` by calling `bridge.dispose()` followed by your
own `bridge.renderWindow.destroy()`, **remove that external `destroy()` call**
— `dispose()` now does it for you, and Electron does not guarantee a second
`destroy()` on an already-destroyed window is safe (it can throw "Object has
been destroyed"). The library's own guard only covers its *internal*
`destroy()` call inside `dispose()`; it does not protect an external call made
*after* `dispose()` returns. If you must keep the workaround temporarily,
either guard it yourself
(`if (!bridge.renderWindow.isDestroyed()) bridge.renderWindow.destroy();`) or
call it **before** `dispose()`, not after.

### `TextureBridge.forwardFrames(target, options?)`

```typescript
const forward = bridge.forwardFrames(monitorWindow.webContents, {
  extraArgs: [slot],
  onStatus: (s) => log(`slot ${slot} forwarding`, s.ok ? "ok" : s.reason),
});
if (!forward.active) log(`slot ${slot} was refused — no frames will arrive`);
// later
forward.dispose(); // idempotent
```

Registers a `WebContents` (e.g. a monitor/multiviewer window) to receive every subsequent paint frame over the same zero-copy shared-texture path `forwardSharedTexture` uses — no pixel readback, just a GPU handle.

**Best-effort contract**, same as the preview path: forward failures (a `ForwardDefect` from the core `forwardSharedTexture` primitive) never stop the stream, never surface as an `"error"` event, and never affect `frameDropped`/`droppedReason` — they are reported as state transitions on `forwardStatus` (bridge-wide) and `options.onStatus` (this registration only). `FrameForward.active` covers the other half: it is `false` when the registration was refused outright (bridge disposed, or target already destroyed) and flips to `false` when the target is destroyed or the forward is disposed. **Independent of the native Syphon/Spout send** — forwarding runs before `sendTextureFromPaintEvent` inside the paint handler, so a thrown native send failure can't suppress a registered forward, and a forward failure can never block the native send either; the two paths fire regardless of each other's outcome.

`FrameForward.dispose()` unregisters that one target and is idempotent — calling it twice, or after `bridge.dispose()` already cleared it, is a no-op. `bridge.dispose()` clears every registered forward.

The receiving end needs nothing new: a forwarded target consumes frames exactly like a Syphon/Spout receiver does — call `bindSharedTextureReceiver(sharedTexture)` once at renderer startup, then `receiver.consume({ onFrame: (frame, ...extraArgs) => ... })`. The `extraArgs` passed to `forwardFrames(target, { extraArgs })` arrive verbatim as the handler's trailing arguments, so one target can demultiplex frames forwarded from several sources (e.g. tag each source with its slot index).

The current implementation imports the texture once per registered target per frame. When several targets share the same source frame, there's room to optimize to "import once per frame → send to every target → release only after all sends settle" — documented as a future option rather than built now, since no current caller needs it (a multiviewer slot is one source to one target).

### `TextureBridge.forwardPreviewFrames(target, options)`

```typescript
// main
const preview = bridge.forwardPreviewFrames(mainWindow.webContents, {
  width: 384, // bounding box; aspect ratio is preserved, never upscaled
  height: 216,
  extraArgs: [slot],
  onStatus: (s) => log(`slot ${slot} preview`, s.ok ? "ok" : s.reason),
});
// later
preview.dispose(); // idempotent
```

```typescript
// preload (contextIsolation stays on)
import { ipcRenderer } from "electron";
import { consumePreviewFrames } from "@napolab/texture-bridge-renderer/client";

consumePreviewFrames(ipcRenderer, {
  onFrame: (frame, slot) => {
    // frame.data: Uint8ClampedArray, width*height*4 tightly packed upright RGBA.
    // Transfer it to the page without a copy:
    window.postMessage({ slot, ...frame }, "*", [frame.data.buffer]);
  },
});

// page
ctx.putImageData(new ImageData(msg.data, msg.width, msg.height), 0, 0);
```

A cheap thumbnail path for a window that only needs to *show* a small copy of
each frame (deck lists, multiviewer thumbnails). Instead of forwarding the
full-resolution shared texture (`forwardFrames`), the native sender downscales
every frame on the GPU **in the same submission as the Syphon/Spout send** and
reads the small result back asynchronously into a 3-slot ring — the send path
never waits on the GPU. The RGBA bytes are delivered with
`webContents.send(PREVIEW_FRAME_CHANNEL, { width, height, data }, ...extraArgs)`.

Why not `forwardFrames` for thumbnails: per frame and per target, Electron's
shared-texture path creates a new GPU SharedImage on import, does a synchronous
sync-token flush on the browser UI thread on send and another in the renderer,
runs a release round-trip, and the first GPU use in the renderer wraps a new
IOSurface backing and copies the full-resolution frame. None of it is cached,
so 4 decks × 30 fps of 1080p thumbnails cost far more than the pixels shown.
The preview path replaces all of that with one small GPU pass and one IPC
message (~330 KB for 384×216; 4 × 30 fps ≈ 40 MB/s of structured-clone copies
— a few memcpys of ~1 MB per frame across all decks).

- **Size.** macOS: exactly the aspect-fitted size (1080p in 384×216 → 384×216).
  Windows: the smallest power-of-two mip level covering the fitted size
  (1080p in 384×216 → 480×270), because the downscale uses
  `GenerateMips` (no runtime shader compiler). Always read `width`/`height`
  from each frame. One native tap per bridge: with several registrations, the
  oldest registration's bounds are used for all of them.
- **Latency.** macOS: each preview is delivered from the Metal completion of
  its own frame, independent of later frames. Windows: D3D11 has no
  completion callback, so finished readbacks are picked up by polling — at the
  start of the next send (typically one frame behind), and, while the tap is
  on and a readback is pending, by a ~8 ms bridge timer that calls
  `TextureSender.pollPreview()`. So the last frame of a deck that stops
  painting (a paused video, a static page) still arrives, roughly one timer
  tick after the GPU finishes it. The timer is never armed on macOS, nor
  while no readback is pending.
- **Copies.** Each delivered preview is copied twice on the CPU: readback →
  an owned buffer (the ring slot is reused immediately), then → the JS
  `Buffer`, because Electron forbids external buffers (napi-rs falls back to
  `napi_create_buffer_copy`); `webContents.send` then structured-clones it per
  target.
- **Pixels.** Upright, R,G,B,A byte order, straight from the paint texture.
  With `includeAlpha: true` the OSR texture is premultiplied, so semi-
  transparent pixels look darker through `putImageData` (which expects
  straight alpha).
- **Best-effort contract**, same as `forwardFrames`: a preview problem never
  emits `"error"` and never affects the Syphon/Spout output. Transitions are
  reported through `forwardStatus` / `onStatus` — `send-failed` (e.g. an
  `extraArgs` value that cannot be cloned), `target-destroyed`, and
  `preview-unavailable` when the native tap cannot be set up (unsupported
  platform, Metal pipeline failure, an older native binary without
  `setPreview`). In that last case the registration stays `active` and the tap
  is retried on the next registration change or `resize()`; once a retry
  succeeds, every registration — including the ones that reported
  `preview-unavailable` — moves to `ok` with the next delivered frame.
- **Lifecycle.** The native tap only runs while at least one registration
  exists (the GPU pass and readback stop when the last one is disposed or its
  target is destroyed), and is re-installed on the sender `resize()` rebuilds.
  `active` / inert-handle rules match `forwardFrames`; bounds that are not
  finite or round to less than 1 (e.g. `0.4`, `Infinity`) also yield an inert
  handle. Each frame is a standalone IPC message, so
  registering before the target finishes loading — or a target reload — needs
  no handshake: frames sent while nobody listens are simply dropped.

Lower level: `TextureSender.setPreview(maxWidth, maxHeight, callback | null)`
on `@napolab/texture-bridge` / `-core` exposes the native tap directly
(`callback` receives `{ data: Buffer, width, height }` on the JS thread). It
covers `send` / `sendSurface`, plus `sendRgbaBuffer` on macOS
(`sendRgbaBuffer` is not implemented on Windows). Once `setPreview` (or
`stop()`) returns, the previous callback is never invoked again, even for
frames already queued for it. On Windows, direct users must drive delivery
themselves: after a send, call `TextureSender.pollPreview()` from a short
timer while it returns `true` (it maps finished readbacks without waiting and
returns whether one is still pending), or the last frame before sends stop is
never delivered. On macOS `pollPreview()` is a no-op that returns `false`.

### `consumePreviewFrames(ipcRenderer, handlers)` (from `renderer/client`)

Subscribes to `forwardPreviewFrames` messages (only `on` / `removeListener`
are used, so any `EventEmitter` works in tests). `onFrame(frame, ...extraArgs)`
receives `{ width, height, data: Uint8ClampedArray }` — a view (no copy) over
the bytes Electron deserialized for that message, safe to keep or transfer.
Malformed messages and `onFrame` throws go to `onError` (default
`console.error`) without stopping delivery. Returns `{ dispose() }`
(idempotent); several consumers can share one `ipcRenderer`.

### `createWorkerRenderer(options)` (from `renderer/client`)

Renderer-process helper for setting up a canvas-to-Worker pipeline with automatic resize propagation.

```typescript
import { createWorkerRenderer } from "@napolab/texture-bridge-renderer/client";

createWorkerRenderer({
  worker: new MyWorker(),
  width: 1920,
  height: 1080,
});
```

### `bindSharedTextureReceiver(sharedTexture)` (from `renderer/client`)

```typescript
import { sharedTexture } from "electron";
import { bindSharedTextureReceiver } from "@napolab/texture-bridge-renderer/client";

// Binds Electron's single sharedTexture.setSharedTextureReceiver slot —
// the only side effect. Call once at renderer startup.
const receiver = bindSharedTextureReceiver(sharedTexture);

const registration = receiver.consume({
  onFrame: ({ textureId, videoFrame }, ...extraArgs) => {
    // videoFrame is a Web VideoFrame backed by the shared texture.
    // drawImage(videoFrame) — zero-copy GPU blit
    // device.importExternalTexture({ source: videoFrame }) — WebGPU path
  },
  onError: (err) => console.error(err),
});

registration.dispose();   // remove this consumer from the pool (idempotent)
receiver.dispose();       // tear the binding down (idempotent)
```

Binds Electron's single `sharedTexture.setSharedTextureReceiver` slot to a fresh consumer pool and returns a `BoundSharedTextureReceiver` handle. Electron's `sharedTexture` module is passed in rather than imported, so the binding has an explicit owner and lifetime (tests can pass `{ setSharedTextureReceiver: vi.fn() }`). Requires Electron 40+.

The handle has two methods:

- **`consume(handlers)`** — registers one consumer in this binding's pool and returns `{ dispose() }` (idempotent). Purely a registration; it never touches the Electron slot. Multiple consumers coexist: each active consumer receives its own `VideoFrame` per incoming imported texture, the wrapper closes that `VideoFrame` after `onFrame` settles, and the underlying imported texture is released exactly once after all consumers have finished. `extraArgs` passed by the main process (`forwardFrames(target, { extraArgs })`, `createSharedTextureReceiver({ extraArgs })`) arrive verbatim as the handler's trailing arguments.
- **`dispose()`** — idempotent. Drops every registered consumer and frees the `sharedTexture` target so it can be bound again. Electron has no API to unset the receiver, so the installed callback stays and keeps draining (releasing) frames that still arrive; a later `bindSharedTextureReceiver` on the same target replaces it (Electron's slot is last-wins).

Errors (both exported from `renderer/client`):

| Error | Thrown when |
| ----- | ----------- |
| `SharedTextureReceiverAlreadyBoundError` | `bindSharedTextureReceiver` is called on a `sharedTexture` that already has a live binding. `dispose()` the existing binding first. |
| `SharedTextureReceiverDisposedError` | `consume()` is called on a handle after its `dispose()`. |

The handler types `SharedTextureConsumerFrame`, `SharedTextureConsumerHandlers`, `SharedTextureConsumerRegistration`, plus `BoundSharedTextureReceiver` and `SharedTextureReceiverTarget`, are exported from `renderer/client` as types.

> This replaces the former global install-then-consume function pair, which has been removed. Migrate by binding once — `const receiver = bindSharedTextureReceiver(sharedTexture);` — and calling `receiver.consume(h)` wherever you previously registered a consumer.

### `createMultiDispatcher(options)` (from `renderer/client`)

Low-level fan-out primitive: one `handler(...)` invokes all registered callbacks and reduces their results through a user-supplied `combine` function. `bindSharedTextureReceiver` is built on top of it, but it is exported so you can build your own "one upstream slot, many downstream consumers" adapters (e.g. a preload-to-renderer bridge). See JSDoc in `packages/renderer/src/client/multi-dispatcher.ts` for the full API.

### `createSharedTextureReceiver(options): SharedTextureReceiverBridge`

Factory function that creates a **zero-copy GPU** receiver bridge. Polls `TextureReceiver.receiveSharedTexture()` and delivers each frame to a target renderer via Electron's `sharedTexture.importSharedTexture` + `sendSharedTexture` pair. Verified end-to-end on both Windows (Spout) and macOS (Syphon Metal).

```typescript
interface SharedTextureReceiverOptions {
  senderName: string;                 // Syphon server / Spout sender name
  target?: Electron.WebContents;      // primary receiver webContents (optional: use forwardFrames for every target)
  mode?: "push" | "poll";             // default "push" on macOS/Windows, "poll" elsewhere; push is latest-wins
  pollIntervalMs?: number;            // poll mode only; default 16 (~60 fps); drop-latest applied
  appName?: string;                   // (macOS only) filter by application name
  serverUuid?: string;                // (macOS only) connect by server UUID
  extraArgs?: readonly unknown[];     // primary target only; forwarded to sendSharedTexture(..., ...args)
}

interface SharedTextureReceiverBridge {
  on(event: "fps", listener: (fps: number) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "disposed", listener: () => void): this;

  start(): void;                      // begin polling
  stop(): void;                       // pause polling (bridge can be started again)
  dispose(): void;                    // terminal: stop + release native receiver
  [Symbol.dispose](): void;           // same as dispose()

  // fan-out: one native receive + one import per frame, sent to every target
  forwardFrames(target: Electron.WebContents, options?: FrameForwardOptions): FrameForward;

  readonly isDisposed: boolean;
}
```

`dispose()` is terminal and idempotent. After 10 consecutive `"error"` events the bridge stops itself automatically (circuit breaker) and emits one final error describing the shutdown.

#### `SharedTextureReceiverBridge.forwardFrames(target, options?)`

Delivers the same source to more targets without another native receive. Each frame is imported once, sent to every live target (the optional primary `target` plus every forward), and the imported texture is released once after every send of that frame has settled.

```typescript
// one receiver per source, many viewers
const receiver = createSharedTextureReceiver({ senderName: "Resolume Arena" });
const main = receiver.forwardFrames(mainWindow.webContents, { extraArgs: [0] });
const monitor = receiver.forwardFrames(multiviewer.webContents, {
  extraArgs: [3],
  onStatus: (status) => console.log("[monitor]", status),
});
receiver.start();

monitor.dispose(); // stop delivering to that target (idempotent)
```

Same contract as [`TextureBridge.forwardFrames`](#texturebridgeforwardframestarget-options), with the receive-side specifics:

- **Per-target latest-wins.** Each target keeps at most one in-flight send and one queued frame. A slow renderer drops only its own frames; the others keep receiving every frame.
- **Best-effort.** A forward's import/send failures are reported only through `onStatus` (deduped to state changes) — never on `"error"`, and they never trip the circuit breaker. Receive and import errors, and send errors of the primary `target`, keep the existing `"error"` + circuit-breaker semantics.
- **No target, no import.** With no live target (target-less receiver whose forwards are all disposed) the native handle is closed without importing.
- **Lifecycle.** A forward unregisters itself when its target is destroyed. `stop()` / `dispose()` drop every queued frame; nothing is sent after they return. Calling `forwardFrames()` after `dispose()` or with an already-destroyed target returns an inert handle (`active: false`).
- `"fps"` counts frames delivered to at least one target. A delivered frame resets the circuit-breaker counter.

### `createTextureReceiver(options): TextureReceiverBridge`

Factory function that creates a texture receiver with polling and FPS tracking.

```typescript
interface TextureReceiverBridgeOptions {
  senderName: string;      // Syphon server name / Spout sender name
  appName?: string;        // (macOS only) Filter by application name
  serverUuid?: string;     // (macOS only) Connect by server UUID
  pollIntervalMs?: number; // Frame polling interval in ms (default: 16)
}
```

### `TextureReceiverBridge`

```typescript
interface TextureReceiverBridge {
  on(event: "frame", listener: (frame: ReceivedFrame) => void): this;
  on(event: "fps", listener: (fps: number) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "disposed", listener: () => void): this;

  start(): void;   // Begin polling for frames
  stop(): void;    // Pause polling
  dispose(): void; // Release all resources

  readonly isDisposed: boolean;
}

interface ReceivedFrame {
  data: Buffer;    // RGBA pixel data
  width: number;
  height: number;
}
```

### `SenderDiscovery`

EventEmitter that polls for available Syphon servers / Spout senders and emits diff events.

```typescript
const discovery = new SenderDiscovery();
discovery.on("added", (senders: SenderInfo[]) => { /* new senders appeared */ });
discovery.on("removed", (senders: SenderInfo[]) => { /* senders disappeared */ });
discovery.on("updated", (senders: SenderInfo[]) => { /* full current list */ });
discovery.start(1000); // Poll interval in ms
discovery.getSenders(); // Current sender list
discovery.dispose();

interface SenderInfo {
  name: string;
  appName?: string;  // macOS only
  uuid?: string;     // macOS only
}
```

### Worker Protocol Types (from `renderer/worker`)

```typescript
import type { WorkerMessage } from "@napolab/texture-bridge-renderer/worker";

// In your Worker:
self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  switch (e.data.type) {
    case "init":   /* e.data.canvas: OffscreenCanvas */ break;
    case "resize": /* e.data.width, e.data.height */   break;
    case "dispose": break;
  }
};
```

## `@napolab/texture-bridge-core`

### `sendTextureFromPaintEvent(sender, textureInfo)`

Low-level convenience function that handles platform-specific texture handle extraction and forwarding.

- **macOS**: Reads `handle.ioSurface` buffer → calls `sender.sendSurface()`
- **Windows**: Reads `handle.ntHandle` buffer as BigInt64LE → calls `sender.send()`

Returns `undefined` when the frame was handed to the sender, or a `PaintDefect`
(`{ reason: "no-texture" | "no-nt-handle" | "no-io-surface" | "unsupported-platform" }`;
the `unsupported-platform` variant also carries the offending `platform`)
when the frame was dropped. Drops are normal no-ops, not errors — surface them
in your own paint loop the same way `createTextureBridge` does with its
`frameDropped` event. Native send failures throw a `TextureSendError`
(exported from both packages) — the message is preserved and the original
thrown value is available on `error.cause`. With `createTextureBridge`,
these surface on the bridge's `error` event, so you can discriminate with
`instanceof TextureSendError`.

### `forwardSharedTexture(textureInfo, target, extraArgs?)` (from `core/electron`)

```typescript
import { forwardSharedTexture, type ForwardDefect } from "@napolab/texture-bridge-core/electron";

const defect = await forwardSharedTexture(textureInfo, target, extraArgs);
```

Forwards one paint frame to a renderer `WebContents` via Electron's shared-texture channel (`sharedTexture.importSharedTexture` → `sharedTexture.sendSharedTexture`). Zero-copy: only a GPU handle crosses the process boundary — no pixels move.

This lives on a **separate subpath**, `@napolab/texture-bridge-core/electron`, not the package's main entry. The main entry must stay importable without Electron installed — the plain-Node `sendRgbaBuffer` sanity check (see "Minimal sanity check (no Electron)" above) depends on that — so the static `import { sharedTexture } from "electron"` this function needs is quarantined to this subpath and enforced at build time by an electron-free guard on the main entry's output.

Returns `undefined` when the frame was handed to Electron for delivery, or a `ForwardDefect` describing why it was not — the same reporting idiom as `sendTextureFromPaintEvent`'s `PaintDefect | undefined`: the low-level tier reports, the caller decides.

```typescript
type ForwardDefect =
  | { reason: "target-destroyed" }   // target.isDestroyed(), or its mainFrame is gone
  | { reason: "import-failed"; cause: Error }
  | { reason: "send-failed"; cause: Error };
```

Because it's an `async` function, it can never throw synchronously — a defect always surfaces through the returned promise, never as a thrown exception at the call site. When the import succeeds, the imported texture is released in a `finally` regardless of whether the subsequent send succeeds or fails (release-in-finally).

Low-level callers driving their own paint loop can call it directly, alongside `sendTextureFromPaintEvent`. Release the texture in a `finally` — otherwise a thrown `TextureSendError` from `sendTextureFromPaintEvent` (native send failures throw) skips `texture.release()` and leaks the frame. `forwardSharedTexture` never throws synchronously (see above), so it's safe to fire-and-forget before `sendTextureFromPaintEvent` runs — no `await` needed to guarantee the dispatch already started:

```typescript
win.webContents.on("paint", (e) => {
  const texture = e.texture;
  if (!texture) return;
  try {
    void forwardSharedTexture(texture.textureInfo, monitorWC, [slot]); // → renderer (dispatch is synchronous)
    sendTextureFromPaintEvent(sender, texture.textureInfo);           // → Syphon/Spout (throws on failure)
  } finally {
    texture.release();
  }
});
```

### `sendImportedTexture(frame, imported, extraArgs?)` (from `core/electron`)

```typescript
import { sendImportedTexture } from "@napolab/texture-bridge-core/electron";

await sendImportedTexture(targetFrame, importedSharedTexture, extraArgs);
```

Delivers an **already-imported** shared texture (the result of
`sharedTexture.importSharedTexture(...)`) to a target `WebFrameMain`,
releasing it in a `finally` regardless of whether the send succeeds or
fails — release-in-finally, same contract as `forwardSharedTexture`'s
internal delivery step. This is the shared helper both `forwardSharedTexture`
(above) and the renderer package's shared-texture receiver path
(`shared-texture-receiver.ts`, `preview-manager.ts`) call into, so there is
one implementation of "deliver + always release" instead of duplicated
copies. Most callers want `forwardSharedTexture`, which also does the
`importSharedTexture` step; reach for `sendImportedTexture` directly only
when you already hold an imported texture from elsewhere (e.g. a receiver
polling loop) and just need the send-and-release half.

### `TextureSender`

Native class for sending textures to Syphon/Spout receivers.

```typescript
class TextureSender {
  constructor(name: string, width: number, height: number);
  send(handle: number, width: number, height: number): void;
  sendSurface(surfaceBuffer: Buffer, width: number, height: number): void;
  sendRgbaBuffer(data: Buffer, width: number, height: number, bytesPerRow?: number): void;
  platform(): string;
  stop(): void;  // Terminal — releases native resources immediately
}
```

### `TextureReceiver`

Native class for receiving textures from Syphon/Spout senders.

```typescript
class TextureReceiver {
  constructor(senderName: string, appName?: string, serverUuid?: string);
  hasNewFrame(): boolean;
  receiveFrame(): ReceivedFrame | null;                  // RGBA readback
  receiveSharedTexture(): SharedTextureFrame | null;     // zero-copy GPU handle (Windows + macOS)
  isConnected(): boolean;
  getWidth(): number;
  getHeight(): number;
  platform(): string;
  stop(): void;  // Terminal — releases native resources immediately
}

interface SharedTextureFrame {
  width: number;
  height: number;
  pixelFormat: "bgra" | "rgba" | "rgbaf16";
  ownerPid: number;        // process ID that owns the handle (usually process.pid)
  handle: Buffer;          // 8-byte LE: NT HANDLE on Windows, IOSurfaceRef pointer on macOS
}
```

Each `handle` is a fresh, owning native reference. Call `closeNativeHandle(handle)` exactly once for every handle — also after handing it to `sharedTexture.importSharedTexture`, which never takes ownership (it duplicates / retains its own reference) — otherwise you leak an NT HANDLE / IOSurface retain per frame.

### `closeNativeHandle(handle)`

```typescript
function closeNativeHandle(handle: Buffer): void;
```

Releases your reference on a native shared-texture handle (NT HANDLE on Windows, `IOSurfaceRef` on macOS) minted by `receiveSharedTexture()`. Call it exactly once per handle, whether or not you imported it: Electron's `importSharedTexture` keeps its own duplicated / retained reference, so closing right after the import call returns (success or throw) is safe. Calling it twice on the same handle is a double close / over-release.

### Resource Lifecycle

Both `TextureSender` and `TextureReceiver` follow deterministic disposal semantics:

1. **`stop()` releases native resources immediately.** Do not rely on garbage collection for cleanup.
2. **`stop()` is terminal.** The instance cannot be reused afterward. Any operational method called after `stop()` will throw an error (sender) or return a safe terminal value (receiver).
3. **`stop()` is idempotent.** Repeated calls are safe and return without error.
4. **Higher-level `dispose()` methods** (on `TextureBridge`, `TextureReceiverBridge`) forward to native `stop()` and are also terminal.

```typescript
// Recommended pattern
const sender = new TextureSender("MyApp", 1920, 1080);
try {
  // ... use sender ...
} finally {
  sender.stop();
}

// Also supports Symbol.dispose for use with `using` declarations.
// Requires Node.js 22+ (or a runtime with Symbol.dispose support) and
// `"lib": ["ESNext.Disposable"]` in your tsconfig.json.
// Import from @napolab/texture-bridge-core for runtime Symbol.dispose patching.
using sender = new TextureSender("MyApp", 1920, 1080);
```

### `listSenders()`

```typescript
function listSenders(): Array<{ name: string; appName?: string; uuid?: string }>;
```

### `getPlatform()`

```typescript
function getPlatform(): "spout" | "syphon-metal" | "unsupported";
```

`getPlatform()` and the instance method `sender.platform()` / `receiver.platform()` return the same string set:

| Value | Meaning |
|-------|---------|
| `"syphon-metal"` | macOS — Syphon Metal backend active |
| `"spout"` | Windows — Spout backend active |
| `"unsupported"` | Platform without a backend (no-op sends/receives) |

### Types

```typescript
type PixelFormat = "bgra" | "nv12" | "rgba" | "rgbaf16";

interface TextureInfo {
  pixelFormat: PixelFormat;
  codedSize: { width: number; height: number };
  visibleRect: { x: number; y: number; width: number; height: number };
  handle: {
    ntHandle?: Buffer;   // Windows (Electron 40+)
    ioSurface?: Buffer;  // macOS
  };
}

interface PaintTexture {
  textureInfo: TextureInfo;
  release?: () => void;
}

type Platform = "spout" | "syphon-metal" | "unsupported";
```

