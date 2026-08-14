---
name: managing-frame-forward-lifecycle
description: Use when registering or tearing down `TextureBridge.forwardFrames` targets — a monitor/multiviewer window the user can close and reopen, decks connected and disconnected repeatedly, a bridge disposed while forwards are still registered — or when about to add "destroyed"/"closed" listener bookkeeping, removeListener hygiene, isDestroyed guards, or try/catch around `forward.dispose()`, or when chasing a MaxListenersExceededWarning or a leak around forwarding.
---

# Managing frame-forward lifecycle

## Overview

**A `forwardFrames` registration cleans itself up.** It prunes its own entry when the target dies, unhooks its own listener when disposed, and refuses to register at all when registration could not self-clean. Bookkeeping layered on top is redundant — and the listener bookkeeping is itself the leak people write it to prevent.

## The contract

| Situation | The library already does this | You do |
|---|---|---|
| Target `WebContents` destroyed later (its window closed) | Entry is auto-pruned via an internal `once("destroyed")` — no forwarding to a dead target | nothing |
| `forward.dispose()` | Deletes the entry **and removes that internal `"destroyed"` listener** from your target. Idempotent, never throws, safe after the target died | call it (see below) |
| `bridge.dispose()` | Unhooks every entry's listener, then clears all entries | nothing |
| `forwardFrames()` after `bridge.dispose()` | Does **not** register; returns an inert `FrameForward` whose `dispose()` is a no-op and whose `active` is `false` | see "own the truth" below |
| `forwardFrames()` with an already-destroyed target | Same — inert handle, `active: false`, no registration, no leak | same |
| A live registration stops delivering (target dies mid-session, import or send fails) | Reports the change on `"forwardStatus"` / `options.onStatus`, and keeps trying every frame | log both edges (see 4) |

Repeated connect/disconnect on one long-lived multiviewer window accumulates nothing: each `dispose()` takes its listener with it.

## What you still own

1. **Dispose before you drop the handle.** Overwriting a `Map` entry that holds a live `FrameForward` leaks the registration — the library cannot see your map.
2. **Re-register after the target window is recreated.** A reopened window is a new `WebContents`; the old entry already pruned itself, so connect again against the new one.
3. **Own the truth of your own connected state — and throw when it is false.** A refused registration still hands you a handle; what it does not hand you is frames. `FrameForward.active` is `false` in that case, so the failure is detectable — but detectable is not the same as handled. Check `bridge.isDisposed` / `target.isDestroyed()` *yourself, before registering*, and **throw a named error** when the check fails; assert `forward.active` after the call as the backstop for whatever your pre-check missed. Do not return a boolean or an `undefined` handle: a status a caller can ignore is a UI that says "connected" over a dead deck.

4. **Subscribe to `forwardStatus` (or pass `onStatus`) for the deaths that happen later.** Registration succeeding says nothing about the next hour: the target can die, an import can start failing, and forwarding is best-effort — the stream survives, silently. The event is deduped to transitions, so a plain log of every status is already an outage report: `{ ok: false }` with no `{ ok: true }` after it means that target has been dark since that timestamp. Tag each registration with `extraArgs` so the log says *which* one.

```typescript
export class ForwardTargetUnavailableError extends Error {
  override name = "ForwardTargetUnavailableError";
}

const forwards = new Map<number, FrameForward>();

/** @throws {ForwardTargetUnavailableError} the bridge is disposed or the monitor is destroyed. */
export const connect = (slot: number, bridge: TextureBridge, monitor: BrowserWindow): void => {
  forwards.get(slot)?.dispose();                             // never overwrite a live handle
  if (bridge.isDisposed || monitor.webContents.isDestroyed()) {
    throw new ForwardTargetUnavailableError(`slot ${slot}: bridge disposed or monitor destroyed`);
  }
  forwards.set(slot, bridge.forwardFrames(monitor.webContents, { extraArgs: [slot] }));
};

export const disconnect = (slot: number): void => {
  forwards.get(slot)?.dispose();      // idempotent — fine even if the window already died
  forwards.delete(slot);
};
```

That is the whole manager. No `"destroyed"` listener, no `removeListener`, no try/catch, no `bridge.on("disposed")` teardown pass.

At the edge that drives the UI (an IPC handler, a menu action), fold that throw into a value once — `Result.fromThrowable` bound at module scope, matched at the edge, never re-exported:

```typescript
const safeConnect = Result.fromThrowable(connect, (cause) => toConnectError(cause));

ipcMain.handle("deck:connect", (_e, slot: number) =>
  safeConnect(slot, decks[slot].bridge, monitorWindow).match(
    () => ({ connected: true }),
    (error) => ({ connected: false, reason: error.message }),
  ),
);
```

Which bridge calls throw, reject, or model their failures instead: see the handling-texture-bridge-failures skill.

## Common Mistakes

| Mistake | Reality |
|---------|---------|
| `target.once("destroyed", () => forward.dispose())` | The registration already does this internally. Yours is a second listener on the same target — the accumulation you were guarding against. |
| Calling `target.removeListener("destroyed", ...)` (guarded by `isDestroyed()`) at teardown | That exact code lives inside `forward.dispose()`. |
| `try { forward.dispose() } catch {}` "in case the target is dead" | `dispose()` is idempotent and internally guarded. It does not throw. |
| `bridge.on("disposed", ...)` to tear down that bridge's forwards | `bridge.dispose()` clears and unhooks them before the event is emitted. |
| Pre-checking `isDisposed` to stop the library from leaking a registration | It never registers — there is nothing to protect it from. You pre-check to *report*, not to guard. |
| Returning `false` / `undefined` / a null handle when registration is impossible | A status the caller can drop on the floor, which is how a dead deck stays lit in the UI. Throw a named error; fold it with `Result.fromThrowable` at the edge. |
| `throw` from inside a paint-rate path, or a `"destroyed"` handler | Throw at *registration*, where a human action is waiting for an answer. Per-frame failures stay best-effort. |
| `forwards.set(slot, bridge.forwardFrames(...))` over an existing entry | The overwritten handle is unreachable and still registered — the one real leak in this API. |
| Keeping decks "connected" across a window close and expecting frames after reopen | The old entry self-pruned. New window = new `WebContents` = new `forwardFrames` call. |
| Expecting forward failures on `bridge.on("error")` / `frameDropped` | Wrong channel — forwarding reports on `"forwardStatus"` / `options.onStatus`. |
| Registering forwards and subscribing to nothing | The one failure mode with no other symptom: paint, sender and preview stay healthy while the monitor goes black. One `forwardStatus` listener is the whole fix. |
