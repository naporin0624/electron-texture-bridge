---
name: handling-texture-bridge-failures
description: Use when adding error handling, telemetry, or crash-safety to code that uses @napolab/texture-bridge — deciding whether a call needs a try/catch or a Result.fromThrowable wrapper, reviewing the failure handling of a texture-bridge integration, defining error classes for bridge or receiver operations, or diagnosing silently black output or a main-process crash from a bridge call.
---

# Handling texture-bridge failures

## Overview

Failures in this library take five shapes, and **which shape a given call uses is fixed by its contract** — not something to guess from the signature. Wrap the ones that throw. Everything else is guaranteed, and wrapping it produces error classes for failures that cannot happen.

## The failure surface

| Call | Fails by |
|---|---|
| `await createTextureBridge(options)` | **rejects** — called before `app.whenReady()`, native sender construction, renderer load failure |
| `bridge.resize(w, h)` | **throws** — rebuilding the native sender can fail. Size is rolled back first, so the bridge stays usable |
| `bridge.openPreview()` | **throws** — `new BrowserWindow` inside can fail |
| `bridge.forwardFrames(target, opts?)` | **cannot fail** — returns an inert `FrameForward` when the bridge is disposed or the target is dead. Read `.active` to tell the two apart |
| `forward.dispose()`, `bridge.dispose()`, `bridge.closePreview()`, `sender.stop()`, receiver `start()` / `stop()` / `dispose()` / `setFlipY()` | **cannot fail** — idempotent |
| `sendTextureFromPaintEvent(sender, textureInfo)` | **returns a `PaintDefect`** for drops **and throws `TextureSendError`** on native send failure — both, on the same call |
| `forwardSharedTexture(textureInfo, target, extraArgs?)` | **returns a `ForwardDefect`** — never throws, never rejects |
| `sendImportedTexture(frame, imported, extraArgs?)` | **rejects** — async fn, so never a sync throw |
| `new TextureSender(...)`, `sender.send/sendSurface/sendRgbaBuffer`, `closeNativeHandle(buf)`, `listSenders()` | **throw** (native) |
| `createTextureReceiver(opts)`, `createSharedTextureReceiver(opts)` | **throw** — construction only (no such sender). `createSharedTextureReceiver` also throws `TypeError` for a non-positive `pollIntervalMs`; `createTextureReceiver` does not validate it |
| `bridge` paint pipeline, receiver poll loops, `SenderDiscovery` | **emit** — `"error"`, plus `"frameDropped"` (`PaintDefect`) on a bridge. Forward failures reach neither: they surface on `"forwardStatus"` (and `options.onStatus`) as state changes |
| `getPlatform()`, `sender.platform()`, `receiver.isConnected/getWidth/getHeight`, `bridge.isDisposed` | **cannot fail** — safe defaults |

## What to wrap

Wrap exactly the rows above marked **throws** or **rejects**, and nothing else:

```typescript
// Bound once at module scope — arguments are forwarded, never an inline call.
const safeResize = Result.fromThrowable(
  (bridge: TextureBridge, w: number, h: number) => bridge.resize(w, h),
  (cause) => new DeckResizeError(toMessage(cause), { cause }),
);

// Teardown needs no wrapper at all: these are contract-guaranteed idempotent.
forward.dispose();
bridge.dispose();
receiver.dispose();
```

For the emitting surfaces, subscribe — do not wrap the call that set them up:

```typescript
bridge.on("error", (error) => telemetry.report("deck.error", error));       // TextureSendError etc.
bridge.on("frameDropped", (defect) => metrics.countDrop(defect.reason));    // NOT an error
receiver.on("error", (error) => telemetry.report("receiver.error", error)); // typed classes
```

## Two facts that decide most of the code

**A defect is not an error.** `PaintDefect` and `ForwardDefect` are normal dropped frames — a paint arrived without a shareable handle, a monitor window closed. Count them, show them in a HUD, alert on a sustained rate. Reporting each one as an error buries the real failures.

**But a defect that never stops is an incident.** `"forwardStatus"` already does the counting for you: it is deduped down to transitions, so every event it delivers is a genuine change of state. One `{ ok: false }` with no `{ ok: true }` behind it means that target has been dark ever since — log both edges and the outage interval reads straight out of the log.

**`sendTextureFromPaintEvent` is the one call that does both.** Handling only its return value silently drops `TextureSendError`, which means a dead sender — black Syphon output — with nothing in telemetry. In a bridge, that throw already reaches `bridge.on("error")`. In your own paint loop, it is yours:

```typescript
win.webContents.on("paint", (e) => {          // stays sync
  const texture = e.texture;
  if (!texture) return;
  try {
    void forwardSharedTexture(texture.textureInfo, monitorWC, [slot]);   // defect-only, fire-and-forget
    const defect = safeSendPaint(sender, texture.textureInfo).match(
      (paintDefect) => paintDefect,                                      // drop → count it
      (error) => { telemetry.report("capture.sender", error); return undefined; },   // throw → alert
    );
    if (defect) metrics.countDrop(defect.reason);
  } finally {
    texture.release();     // runs even when the send throws
  }
});
```

## Common Mistakes

| Mistake | Reality |
|---------|---------|
| A generic `runReporting(scope, fn)` helper wrapped around every library call | Turns four real failure modes into noise and hides which calls actually need attention. Wrap the throwing rows only. |
| `try { forward.dispose() } catch {}` / `try { bridge.dispose() } catch {}` / guarding `receiver.stop()` | Contract-guaranteed idempotent. The catch can never run. |
| Defining `ForwardDisposeError`, `BridgeDisposeError`, `ForwardFramesError` … | Error classes for failures that cannot happen. Delete them; the union should only name reachable failures. |
| "`sendTextureFromPaintEvent` never throws — it returns a defect" | It does both. This is the single most common cause of black output with an empty log. |
| `Result.fromThrowable` around `forwardSharedTexture` / `sendImportedTexture` / `createTextureBridge` | Async: no sync throw to catch. Use the resolved defect, or `ResultAsync.fromPromise` for the two that reject. |
| `.catch()` on `forwardSharedTexture(...)` | It resolves its defect, never rejects. The handler is dead code. |
| Reporting a `PaintDefect` / `ForwardDefect` through the error channel | A dropped frame is not an incident. Count it. |
| `bridge.resize(w, h)` unguarded in a settings-dialog handler | An uncaught throw in the main process takes the app down. This is one of the two throwing bridge methods. |
| Assuming the bridge's `"frameDropped"` / `"error"` covers forwarding | Forwarding has its own channel: `"forwardStatus"` / `options.onStatus`. Neither of the other two ever fires for it. |
| Subscribing to nothing and calling forwarding "best-effort" | Best-effort means *the stream survives failures*, not *failures are invisible*. An unwatched forward that dies looks identical to a healthy one at every other layer — paint, sender, preview and `droppedReason` all stay green while the monitor sits black. |
| Treating `forwardFrames()` as proof the wiring is live | A refused registration returns a handle too. `if (!forward.active)` right after the call is the one-line check that catches it. |
