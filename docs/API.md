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
  | { ok: false; reason: "target-destroyed" | "import-failed" | "send-failed"; cause?: Error };

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

The receiving end needs nothing new: a forwarded target consumes frames exactly like a Syphon/Spout receiver does — call `installSharedTextureReceiver()` once at renderer startup, then `consumeSharedTexture({ onFrame: (frame, ...extraArgs) => ... })`. The `extraArgs` passed to `forwardFrames(target, { extraArgs })` arrive verbatim as the handler's trailing arguments, so one target can demultiplex frames forwarded from several sources (e.g. tag each source with its slot index).

The current implementation imports the texture once per registered target per frame. When several targets share the same source frame, there's room to optimize to "import once per frame → send to every target → release only after all sends settle" — documented as a future option rather than built now, since no current caller needs it (a multiviewer slot is one source to one target).

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

### `installSharedTextureReceiver()` (from `renderer/client`)

```typescript
import { installSharedTextureReceiver } from "@napolab/texture-bridge-renderer/client";

installSharedTextureReceiver();
```

Binds Electron's single `sharedTexture.setSharedTextureReceiver` slot to an internal consumer pool so multiple `consumeSharedTexture` calls can coexist. Idempotent — call once at renderer startup before any `consumeSharedTexture` call. Requires Electron 40+.

### `consumeSharedTexture(handlers)` (from `renderer/client`)

```typescript
import { consumeSharedTexture } from "@napolab/texture-bridge-renderer/client";

const registration = consumeSharedTexture({
  onFrame: ({ textureId, videoFrame }, ...extraArgs) => {
    // videoFrame is a Web VideoFrame backed by the shared texture.
    // drawImage(videoFrame) — zero-copy GPU blit
    // device.importExternalTexture({ source: videoFrame }) — WebGPU path
  },
  onError: (err) => console.error(err),
});

registration.dispose();   // remove this consumer from the pool (idempotent)
```

Registers a consumer in the pool bound by `installSharedTextureReceiver`. Each active consumer receives its own `VideoFrame` per incoming imported texture; the wrapper closes the `VideoFrame` after `onFrame` settles and releases the underlying imported texture exactly once after all consumers have finished.

### `createMultiDispatcher(options)` (from `renderer/client`)

Low-level fan-out primitive: one `handler(...)` invokes all registered callbacks and reduces their results through a user-supplied `combine` function. `installSharedTextureReceiver` is built on top of it, but it is exported so you can build your own "one upstream slot, many downstream consumers" adapters (e.g. a preload-to-renderer bridge). See JSDoc in `packages/renderer/src/client/multi-dispatcher.ts` for the full API.

### `createSharedTextureReceiver(options): SharedTextureReceiverBridge`

Factory function that creates a **zero-copy GPU** receiver bridge. Polls `TextureReceiver.receiveSharedTexture()` and delivers each frame to a target renderer via Electron's `sharedTexture.importSharedTexture` + `sendSharedTexture` pair. Verified end-to-end on both Windows (Spout) and macOS (Syphon Metal).

```typescript
interface SharedTextureReceiverOptions {
  senderName: string;                 // Syphon server / Spout sender name
  target: Electron.WebContents;       // Receiver window webContents
  pollIntervalMs?: number;            // default 16 (~60 fps); drop-latest applied
  appName?: string;                   // (macOS only) filter by application name
  serverUuid?: string;                // (macOS only) connect by server UUID
  extraArgs?: readonly unknown[];     // forwarded to sendSharedTexture(..., ...args)
}

interface SharedTextureReceiverBridge {
  on(event: "fps", listener: (fps: number) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "disposed", listener: () => void): this;

  start(): void;                      // begin polling
  stop(): void;                       // pause polling (bridge can be started again)
  dispose(): void;                    // terminal: stop + release native receiver
  [Symbol.dispose](): void;           // same as dispose()

  readonly isDisposed: boolean;
}
```

`dispose()` is terminal and idempotent. After 10 consecutive `"error"` events the bridge stops itself automatically (circuit breaker) and emits one final error describing the shutdown.

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

Each `handle` is a fresh, owning native reference. Either hand it to `sharedTexture.importSharedTexture` (Electron takes ownership) or call `closeNativeHandle(handle)` — otherwise you leak an NT HANDLE / IOSurface per frame.

### `closeNativeHandle(handle)`

```typescript
function closeNativeHandle(handle: Buffer): void;
```

Releases a native shared-texture handle (NT HANDLE on Windows, `IOSurfaceRef` on macOS) that was minted by `receiveSharedTexture()` but never consumed by Electron's `importSharedTexture`. Only call this for handles you have **not** forwarded to Electron; Electron releases handles it has taken ownership of on its own.

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

