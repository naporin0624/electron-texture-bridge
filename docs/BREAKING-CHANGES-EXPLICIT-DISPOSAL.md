# Breaking Change Notes: Explicit Native Disposal

This document describes the breaking changes introduced by moving native sender/receiver cleanup from GC-driven behavior to explicit disposal semantics.

## Summary

The library will no longer rely on JavaScript garbage collection to eventually release native GPU/IPC resources.

Instead:

- `TextureSender.stop()` will release native resources immediately.
- `TextureReceiver.stop()` will release native resources immediately.
- Higher-level `dispose()` methods will become terminal and deterministic.
- Using a stopped sender/receiver will become an explicit error.

This is a behavioral breaking change even if the TypeScript signatures remain similar.

## Why This Is Changing

The previous model depended on GC timing to release native resources such as:

- Syphon server/client handles
- Spout sender/receiver handles
- GPU-backed native objects

That model is not deterministic and makes shutdown behavior hard to reason about in long-running Electron apps.

The new model makes ownership explicit:

- create -> use -> stop/dispose -> unusable

## Affected Packages

- `@napolab/texture-bridge`
- `@napolab/texture-bridge-core`
- `@napolab/texture-bridge-renderer`

## Breaking Changes

### 1. `stop()` becomes terminal

Before:

- `stop()` existed in the API surface, but resource release could still effectively depend on GC timing.
- Reuse after `stop()` might appear to work accidentally.

After:

- `stop()` immediately drops the native resource.
- The object is permanently closed after `stop()`.
- Calling `stop()` multiple times should stay safe and idempotent.

## 2. Post-stop usage becomes invalid

After this change, calling operational methods on a stopped object is no longer tolerated.

Examples:

- `TextureSender.send(...)` after `stop()`
- `TextureSender.sendSurface(...)` after `stop()`
- `TextureSender.sendRgbaBuffer(...)` after `stop()`
- `TextureReceiver.receiveFrame()` after `stop()`
- `TextureReceiver.hasNewFrame()` after `stop()`

Expected new behavior:

- operations fail deterministically with a clear error such as `"TextureSender has been stopped"` or `"TextureReceiver has been stopped"`

## 3. `dispose()` becomes a real teardown boundary

High-level wrappers in `@napolab/texture-bridge-renderer` will no longer merely stop timers or delegate to eventually-collected objects.

After this change:

- `TextureBridge.dispose()` must fully tear down the sender path
- `TextureReceiverBridge.dispose()` must fully tear down the receiver path
- disposed objects must not be reused

## 4. Hidden lifecycle misuse may now surface as runtime errors

Some applications may currently rely on behavior like:

- calling `stop()` and then continuing to use the object
- forgetting to call `dispose()` because GC eventually cleans things up
- replacing a sender/receiver without closing the old one explicitly

Those patterns may start failing once explicit disposal is enforced.

## Migration Guide

### Sender

Before:

```ts
const sender = new TextureSender("MyApp", 1920, 1080);
sender.stop();

// This may have appeared to work before, but should be treated as invalid.
sender.send(handle, 1920, 1080);
```

After:

```ts
const sender = new TextureSender("MyApp", 1920, 1080);

try {
  sender.send(handle, 1920, 1080);
} finally {
  sender.stop();
}
```

Rule:

- once `stop()` is called, discard the instance and create a new one if needed

### Receiver

Before:

```ts
const receiver = new TextureReceiver("MySender");
receiver.stop();

// Invalid after the change
receiver.receiveFrame();
```

After:

```ts
const receiver = new TextureReceiver("MySender");

try {
  const frame = receiver.receiveFrame();
} finally {
  receiver.stop();
}
```

Rule:

- once `stop()` is called, discard the instance and create a new one if needed

### High-Level Renderer API

Before:

```ts
const bridge = await createTextureBridge(...);
bridge.dispose();

// Do not assume this is reusable
bridge.resize(1280, 720);
```

After:

```ts
const bridge = await createTextureBridge(...);
bridge.dispose();

// Create a new bridge instead of reusing the disposed one
```

## Recommended Consumer Changes

- Always pair construction with explicit teardown
- Treat `stop()` and `dispose()` as terminal lifecycle operations
- Do not rely on GC to release native resources
- Recreate sender/receiver/bridge instances instead of reviving stopped ones
- Add tests that assert resources are closed in your app shutdown path

## Compatibility Notes

- Repeated `stop()` / `dispose()` calls should remain safe
- The main breaking change is semantic: previously tolerated lifecycle misuse will now fail explicitly
- If you maintain wrappers around this library, update your own lifecycle contracts to match

## Suggested Release Note Summary

> Native sender/receiver cleanup is now explicit and deterministic. `stop()` and `dispose()` are terminal operations, and stopped objects can no longer be reused.
