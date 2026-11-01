---
name: delivering-imported-textures
description: Use when delivering a GPU texture to a renderer from the Electron main process — about to call `sharedTexture.importSharedTexture` / `sendSharedTexture` / `release()` by hand, deciding where `release()` belongs, wrapping delivery in try/finally or neverthrow tees to guarantee exactly-once release, writing the same deliver-and-release dance in a second module, or delivering a texture you imported yourself from a receiver's native handle.
---

# Delivering imported textures

## Overview

**The import → send → release dance is library code, not app code.** `@napolab/texture-bridge-core/electron` ships it. Hand-rolling it is where paint-texture leaks and double-release crashes come from.

## Pick the altitude — do not hand-roll any of them

| What you hold | Call | Target argument |
|---|---|---|
| A `TextureBridge`, and want every paint frame in a window | `bridge.forwardFrames(target, { extraArgs })` — `@napolab/texture-bridge-renderer` | `WebContents` |
| A `TextureInfo` — from your own `paint` handler, a receiver, anywhere | `forwardSharedTexture(textureInfo, target, extraArgs?)` — `@napolab/texture-bridge-core/electron` | `WebContents` |
| An imported texture handed to you already imported, with no `TextureInfo` in reach | `sendImportedTexture(frame, imported, extraArgs?)` — `@napolab/texture-bridge-core/electron` | `WebFrameMain` (`webContents.mainFrame`) |

**Climb as high as you can.** Holding a `TextureInfo` and calling `importSharedTexture` yourself so you can use `sendImportedTexture` is a downgrade: `forwardSharedTexture` does the import, checks the target, releases on every path, and reports the outcome as a `ForwardDefect` (`{ reason: "target-destroyed" } | { reason: "import-failed"; cause } | { reason: "send-failed"; cause }`) — so you never write an import `try/catch`, a destroyed-target guard, or a release branch. Reach for `sendImportedTexture` only when the import already happened outside your control.

The two target arguments differ on purpose: `forwardSharedTexture` takes the `WebContents` (it resolves and null-checks `mainFrame` itself); `sendImportedTexture` takes the frame.

`forwardSharedTexture` reports, it does not throw or reject: no `try/catch`, and in a neverthrow pipeline it is `ResultAsync.fromSafePromise`, not `fromPromise`. Inspect the resolved defect or discard it — that is the whole failure surface.

That subpath exports exactly `forwardSharedTexture`, `sendImportedTexture`, and the `ForwardDefect` type. Electron's `sharedTexture` namespace comes from `"electron"`, never from this package.

How every other export in the library fails — and which ones need a wrapper: see the handling-texture-bridge-failures skill.

## sendImportedTexture

```typescript
import { sendImportedTexture } from "@napolab/texture-bridge-core/electron";

// frame — a WebFrameMain (win.webContents.mainFrame), NOT the WebContents.
// imported — yours until this call; the library owns it afterwards.
// extraArgs — arrive verbatim as trailing args in consumeSharedTexture's handler.
await sendImportedTexture(win.webContents.mainFrame, imported, [slot]);
```

Three properties are the reason this exists:

- **Releases `imported` in a `finally`** — exactly once, on success, on rejection, and on a synchronous throw from `sendSharedTexture`. You never release it yourself; a second release throws.
- **It is an `async` function**, so calling it never throws synchronously — a throw inside becomes a rejection. `ResultAsync.fromPromise(sendImportedTexture(...), toError)` is the entire neverthrow integration: both failure channels are already funneled into one promise.
- **It owns only what it was given.** The source stays yours: `e.texture.release()` for a paint texture, `closeNativeHandle(handle)` for a receiver handle — once, right after your own `importSharedTexture` call returns, because Electron keeps its own duplicated / retained reference and never adopts yours.

Best-effort call site (never awaited by a paint-rate hot path, never an unhandled rejection):

```typescript
void ResultAsync.fromPromise(sendImportedTexture(frame, imported, [slot]), toError).match(
  () => undefined,
  (error) => onDropped(error),   // or () => undefined for a silently best-effort sink
);
```

## Common Mistakes

| Mistake | Reality |
|---------|---------|
| `import { sharedTexture } from "@napolab/texture-bridge-core/electron"` | Fabrication. `sharedTexture` is Electron's own namespace, from `"electron"`. |
| Calling `importSharedTexture` yourself, on a `TextureInfo` you already hold, to feed `sendImportedTexture` | One altitude too low. `forwardSharedTexture(textureInfo, webContents, extraArgs)` is the whole function. |
| A manual `imported.release()` branch for "the target died between import and send" | That branch exists only because you imported too early. `forwardSharedTexture` checks the target first and reports `{ reason: "target-destroyed" }`. |
| Passing `webContents.mainFrame` to `forwardSharedTexture` | It takes the `WebContents`. Only `sendImportedTexture` takes the frame. |
| `try/catch` around `forwardSharedTexture`, or hand-building a `{ reason: "send-failed" }` in that catch | It resolves defects, never rejects. The catch is dead code that invents failures the library already modeled. |
| Writing `importSharedTexture` + `sendSharedTexture` + `release()` in two modules and noting the duplication | That duplication is the bug this export removed. Import the helper. |
| `.andTee(release).orTee(release)` / matching `try/catch` pairs to prove exactly-once release | Already guaranteed inside. Deleting your tee pair removes the double-release risk with it. |
| `Result.fromThrowable` around the send "in case it throws synchronously" | An async function cannot. One `ResultAsync.fromPromise` covers both channels. |
| `await sendSharedTexture(...); imported.release();` | Not a `finally` — the first failure leaks a texture per frame until the shared-texture pool starves and paint stops. |
| `try { imported.release() } catch {}` | A single valid release does not throw. Swallowing here hides a real double-release. |
| Releasing `imported` after handing it to `sendImportedTexture` | Double release. Hand-off is transfer of ownership. |
| Passing `win.webContents` as `sendImportedTexture`'s first argument | It takes `win.webContents.mainFrame`. |
| `await`ing delivery inside a `paint` handler before releasing the paint texture | The send is already dispatched before the first await; awaiting only pins the paint texture for an IPC round-trip. |
