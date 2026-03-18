# Explicit Native Disposal Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace GC-driven native resource cleanup with explicit, deterministic disposal for senders and receivers across Rust/napi-rs and TypeScript layers.

**Architecture:** Native resource owners (`TextureSender`, `TextureReceiver`) become explicitly closable handles backed by `Option<Inner>`. `stop()` becomes a terminal operation that drops native resources immediately. Higher-level TypeScript `dispose()` methods remain the orchestration boundary and must always forward to native `stop()`. `Drop` remains only as a safety net for abandoned objects.

**Tech Stack:** Rust/napi-rs, TypeScript/EventEmitter, Electron main process

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/native/src/lib.rs` | Modify | Make sender/receiver ownership explicit with `Option<inner>` and terminal `stop()` |
| `packages/native/index.d.ts` | Modify | Align public typings and method semantics with terminal disposal |
| `packages/core/src/index.ts` | Review/Modify | Ensure wrappers still behave correctly with stopped senders |
| `packages/renderer/src/bridge.ts` | Modify | Treat sender disposal as deterministic teardown and prevent post-dispose use |
| `packages/renderer/src/receiver.ts` | Modify | Treat receiver disposal as deterministic teardown and prevent post-dispose use |
| `packages/renderer/src/__tests__/receiver.test.ts` | Modify | Add tests for terminal disposal behavior |
| `README.md` | Modify | Document explicit cleanup contract and non-reusability after `stop()` / `dispose()` |

---

### Task 1: Define the lifecycle contract

**Files:**
- Modify: `README.md`
- Modify: `packages/native/index.d.ts`

- [ ] **Step 1: Standardize the contract**

Document and enforce the following rules:

1. `stop()` releases native resources immediately.
2. `stop()` is terminal; the instance cannot be reused afterward.
3. Repeated `stop()` calls are idempotent.
4. Any operational method called after `stop()` returns a clear error instead of silently succeeding.
5. `dispose()` in higher-level TypeScript wrappers is also terminal and forwards to native `stop()`.

- [ ] **Step 2: Update API docs and generated typings**

Adjust comments in `packages/native/index.d.ts` and user-facing documentation in `README.md` so they no longer imply GC-driven cleanup.

**Notes:**
- Keep `stop()` naming if API compatibility matters, but describe it as “close/dispose semantics”, not “pause”.
- If a future breaking release is acceptable, consider renaming to `dispose()` or `close()` consistently across layers.

---

### Task 2: Make `TextureSender` explicitly own and release native resources

**Files:**
- Modify: `packages/native/src/lib.rs`

- [ ] **Step 1: Change ownership model**

Refactor `TextureSender` from:

```rust
pub struct TextureSender {
    inner: platform::Sender,
    width: u32,
    height: u32,
}
```

to:

```rust
pub struct TextureSender {
    inner: Option<platform::Sender>,
    width: u32,
    height: u32,
}
```

- [ ] **Step 2: Make `stop()` deterministic**

Implement `stop(&mut self)` by calling `self.inner.take()`. Dropping the inner sender must immediately release the underlying native resource.

Expected behavior:
- First `stop()` drops the native sender.
- Subsequent `stop()` calls return `Ok(())`.

- [ ] **Step 3: Guard all sender operations**

Update `send`, `send_surface`, `send_rgba_buffer`, and any other sender operations to return a descriptive error when `inner` is `None`.

Recommended error text:

```rust
Error::from_reason("TextureSender has been stopped")
```

- [ ] **Step 4: Keep `Drop` as fallback**

No special `Drop` impl is needed on `TextureSender` itself if `Option<Sender>` is used correctly; dropping the wrapper naturally drops any remaining inner sender.

---

### Task 3: Make `TextureReceiver` explicitly own and release native resources

**Files:**
- Modify: `packages/native/src/lib.rs`

- [ ] **Step 1: Change receiver ownership model**

Refactor `TextureReceiver` to store:

```rust
inner: Option<platform::receiver::Receiver>
```

- [ ] **Step 2: Change `stop()` to mutable terminal teardown**

Update the napi method signature from `stop(&self)` to `stop(&mut self)` so it can call `self.inner.take()`.

Expected behavior:
- Native receiver is released immediately.
- Repeated `stop()` calls are safe and idempotent.

- [ ] **Step 3: Guard receiver methods after stop**

Update:
- `has_new_frame`
- `receive_frame`
- `is_connected`
- `get_width`
- `get_height`
- `platform` if needed

Recommended behavior:
- Operational methods that need a live native handle return an error or a safe terminal value according to the contract.
- Prefer explicit errors for frame-retrieval methods.
- For informational methods like `get_width` / `get_height`, choose one policy and apply it consistently:
  - Option A: return `0` after stop
  - Option B: throw an explicit “stopped” error

**Recommendation:** return errors for active operations and `0`/`false` for passive queries only if that behavior is documented clearly.

---

### Task 4: Remove hidden reliance on private fields in TypeScript orchestration

**Files:**
- Modify: `packages/renderer/src/bridge.ts`

- [ ] **Step 1: Internalize lifecycle-sensitive behavior**

Reduce reliance on `(bridge as any)` access from the factory function into private fields. The current design makes lifecycle enforcement harder because the paint loop is outside the class and reaches into internals dynamically.

Preferred direction:
- Move paint-event handling behind an instance method on `TextureBridgeImpl`.
- Keep sender access and disposal checks inside the class.

- [ ] **Step 2: Enforce terminal disposal semantics**

After `dispose()`:
- no more paint handling should run
- no more sender recreation should occur
- no further preview sends should occur

If necessary, explicitly remove listeners during teardown rather than relying only on window closure.

---

### Task 5: Make higher-level receiver disposal deterministic

**Files:**
- Modify: `packages/renderer/src/receiver.ts`
- Modify: `packages/renderer/src/__tests__/receiver.test.ts`

- [ ] **Step 1: Preserve current orchestration shape**

`TextureReceiverBridge.dispose()` should continue to:
1. stop polling
2. call native `receiver.stop()`
3. emit `disposed`
4. remove listeners

The difference is that `receiver.stop()` must now actually release the native resource.

- [ ] **Step 2: Add tests for terminal lifecycle**

Add tests for:
- `dispose()` calls native `stop()` exactly once
- calling `dispose()` twice stays safe
- polling does not continue after disposal
- if the bridge somehow tries to use a stopped receiver, the error path is explicit and predictable

---

### Task 6: Verify `core` behavior remains coherent

**Files:**
- Review: `packages/core/src/index.ts`
- Add tests if needed

- [ ] **Step 1: Validate stopped-sender behavior**

`sendTextureFromPaintEvent()` should not mask “sender already stopped” failures if a caller uses it incorrectly after disposal. That should remain a visible programming error.

- [ ] **Step 2: Add or update tests**

If practical, add tests asserting that:
- valid texture data still routes correctly
- stopped sender errors surface rather than being silently swallowed

---

### Task 7: Add Rust-level tests for explicit disposal

**Files:**
- Modify: `packages/native/src/lib.rs`

- [ ] **Step 1: Add focused lifecycle tests where possible**

At minimum, add tests that cover the wrapper-level state transitions, for example:
- calling `stop()` transitions `inner` from `Some` to `None`
- repeated `stop()` is safe
- stopped objects reject operational methods

If platform-specific construction is hard to unit test directly, factor out small helper methods for state checks that can be tested without native handles.

---

### Task 8: Validate the full contract from package boundaries

**Files:**
- Modify tests across `packages/native`, `packages/core`, and `packages/renderer` as needed

- [ ] **Step 1: Run targeted validation**

Run:

```bash
pnpm --filter @napolab/texture-bridge-core test
pnpm --filter @napolab/texture-bridge-renderer test
pnpm --filter @napolab/texture-bridge-core typecheck
pnpm --filter @napolab/texture-bridge-renderer typecheck
```

- [ ] **Step 2: Do manual platform validation where available**

On macOS and Windows, verify:
- creating a sender/receiver works
- calling `stop()` releases the resource immediately
- using the object afterward fails deterministically
- repeated `stop()` is safe

---

## Risks and Decisions

### 1. Error semantics after `stop()`

This must be decided once and kept consistent. Silent no-ops are the worst option because they hide lifecycle misuse.

### 2. API compatibility

Changing receiver `stop()` from `&self` to `&mut self` is internal in Rust but should still be checked against napi-generated bindings and TS call sites.

### 3. Partial teardown vs terminal teardown

Do not mix “temporarily paused” semantics into `stop()`. If pause/resume is ever needed, it should be a separate API.

---

## Definition of Done

- `TextureSender.stop()` drops native resources immediately.
- `TextureReceiver.stop()` drops native resources immediately.
- Repeated `stop()` calls are safe and idempotent.
- Post-stop operational calls fail deterministically and are documented.
- TypeScript `dispose()` methods rely on explicit teardown, not GC timing.
- Tests and docs reflect terminal disposal semantics consistently.

---

## Optional Ergonomics Layer: Node.js `using` Support

This is a sugar layer on top of the deterministic disposal model above. It must not replace `stop()` / `dispose()` as the primary lifecycle contract.

### Goal

Allow consumers on modern Node.js / TypeScript toolchains to write:

```ts
using sender = new TextureSender("MyApp", 1920, 1080);
using receiver = new TextureReceiver("MySender");
```

while keeping the canonical lifecycle semantics:

- `TextureSender.stop()` is the real teardown primitive
- `TextureReceiver.stop()` is the real teardown primitive
- wrapper `dispose()` methods are the real teardown primitive for higher-level abstractions

### Design Rules

- `using` support is additive only
- `[Symbol.dispose]()` must delegate directly to existing terminal teardown
- `stop()` / `dispose()` remain the documented primary API
- disposal must stay idempotent regardless of whether it is triggered via `using` or explicit calls
- consumers without `using` support must continue to work with `try/finally`

### Candidate API Surface

**Low-level native-facing objects**

- `TextureSender[Symbol.dispose]()` -> calls `stop()`
- `TextureReceiver[Symbol.dispose]()` -> calls `stop()`

**High-level wrappers**

- `TextureBridge[Symbol.dispose]()` -> calls `dispose()`
- `TextureReceiverBridge[Symbol.dispose]()` -> calls `dispose()`

### Recommended Scope

Implement in this order:

1. `TextureSender`
2. `TextureReceiver`
3. `TextureReceiverBridge`
4. `TextureBridge`

The sender/receiver objects are the best fit because they are direct resource owners. The bridge objects are still valid candidates, but they are longer-lived orchestration objects and may be used less often with block-scoped `using`.

### Implementation Approach

- [ ] **Step 1: Keep explicit disposal as the foundation**

Do not start `using` support until the deterministic `stop()` / `dispose()` work is complete.

- [ ] **Step 2: Add `[Symbol.dispose]()` to TypeScript-managed wrappers**

In TypeScript classes that already implement terminal teardown, add:

```ts
[Symbol.dispose](): void {
  this.dispose();
}
```

or for low-level objects:

```ts
[Symbol.dispose](): void {
  this.stop();
}
```

- [ ] **Step 3: Expose `[Symbol.dispose]()` on native classes**

If napi-rs cannot expose symbol-named methods directly in a clean way, add a thin JavaScript wrapper layer in the package entrypoint that decorates the exported constructors/prototypes:

```ts
TextureSender.prototype[Symbol.dispose] = function () {
  this.stop();
};
```

Apply the same pattern to `TextureReceiver`.

- [ ] **Step 4: Document this as ergonomic sugar, not a lifecycle replacement**

Update docs to show both styles:

```ts
using receiver = new TextureReceiver("MySender");
```

and:

```ts
const receiver = new TextureReceiver("MySender");
try {
  // ...
} finally {
  receiver.stop();
}
```

- [ ] **Step 5: Add tests for mixed usage**

Validate:

- explicit `stop()` followed by `[Symbol.dispose]()` is safe
- `[Symbol.dispose]()` followed by explicit `stop()` is safe
- stopped objects remain unusable regardless of disposal path

### Risks

#### 1. Toolchain support is consumer-dependent

`using` support depends on the consumer's Node.js, Electron, and TypeScript/transpilation setup. That makes it unsuitable as the primary lifecycle API.

#### 2. Async factories are less natural with `using`

`createTextureBridge()` is async and returns a long-lived orchestration object. It may still implement `[Symbol.dispose]`, but it is a weaker fit for the `using` pattern than direct sender/receiver handles.

#### 3. Semantic drift

If `[Symbol.dispose]()` and `stop()` / `dispose()` ever diverge, the API becomes confusing immediately. They must remain exact aliases for the same terminal teardown.

### Definition of Done for `using` Support

- `[Symbol.dispose]()` exists on the intended objects
- all symbol-based disposal paths delegate to existing terminal teardown
- documentation presents `using` as optional sugar
- non-`using` consumers remain first-class and fully supported
