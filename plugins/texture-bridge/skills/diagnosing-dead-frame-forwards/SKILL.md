---
name: diagnosing-dead-frame-forwards
description: Use when forwarded frames stop arriving — a preview or monitor window that goes black or shows a "no signal" placeholder, a multiviewer deck frozen on its last frame, previews that die during a long session or for only some targets while Syphon/Spout output keeps working, a forwardFrames registration you suspect never delivered anything, or a dead preview with nothing in the logs.
---

# Diagnosing dead frame forwards

## Overview

Forwarding is the one path in this library whose failure has **no other symptom**. Paint keeps firing, the native sender keeps sending, the preview window keeps updating, `droppedReason` stays `null`, and no `"error"` or `"frameDropped"` ever fires — while the forwarded target sits black. A silent log is the expected appearance of this bug, not evidence against it.

So do not open with a hypothesis. Two signals the library already publishes answer *which layer* in one repro; everything else is guessing at 30fps.

## The two signals, in this order

| # | Signal | Where | Answers |
|---|---|---|---|
| 1 | `FrameForward.active` | return value of `forwardFrames()`, read right after the call | Did the registration ever exist? |
| 2 | `forwardStatus` event / `options.onStatus` | `bridge.on("forwardStatus", …)`, or per registration | Is it delivering, and since when is it not? |

```typescript
const forward = bridge.forwardFrames(target, {
  extraArgs: [slot],                       // tags every status with the slot
  onStatus: (s) => log(`forward ${slot}`, s.ok ? "ok" : s.reason, s.ok ? "" : s.cause),
});
if (!forward.active) log(`forward ${slot} REFUSED — no frames will ever arrive`);
```

`forwardStatus` is deduped to transitions, so a plain log of every event is already the outage report: `{ ok: false }` with no `{ ok: true }` after it means that target has been dark since that timestamp.

## Reading the result

| `active` | Status history | What it means | Where to look next |
|---|---|---|---|
| `false` | none | Registration was refused — the bridge was disposed or the target already destroyed. The caller is holding a dead handle it believes is live | the call site: re-register against the current `WebContents` after a window is recreated |
| `true` | nothing, ever | Paint never reached this entry | is the source painting at all? (see below) — then the registration's own lifecycle |
| `true` → `false` | ends abruptly | The entry was pruned: target destroyed, `dispose()`, or the bridge disposed | whoever tore it down — an unpaired `detach()`, a rebuild that never re-added it |
| `true` | `ok`, then nothing | The library is delivering. Stop looking at the bridge | the renderer: `installSharedTextureReceiver` present? consumer registered? `VideoFrame` drawn? |
| `true` | `target-destroyed` | Target died under the registration | re-register after the window is recreated |
| `true` | `import-failed` / `send-failed` | GPU or IPC layer refused the frame; `cause` carries the error | the `cause`, then GPU/handle pressure |

## An idle source emits nothing — by design

OSR paint is damage-driven. A paused video, a static page, a stalled worker: **zero paint, therefore zero forwards, and that is not a fault.** Confirm the source is actually producing frames — the bridge's `"fps"` event, or a paint counter — *before* you conclude the forward path is broken. Skipping this check turns a paused deck into an afternoon of debugging a healthy pipeline.

## Frozen picture ≠ blank picture

The two look equally "dead" to a user and mean opposite things:

| Symptom | Meaning |
|---|---|
| Last frame frozen on screen | Frames stopped arriving; the consumer still holds its last `VideoFrame`. The break is upstream — source idle, or forwarding dead |
| Black / "no signal" / placeholder | The consumer *discarded* what it held and got nothing since. Something on the receiving side cleared its store; a still-live forward would refill it within a frame |

Ask which one the user actually sees. It splits the search space in half before you touch any code.

## Do not instrument first

The failure is timing-sensitive. In a real investigation, adding logging around the paint path moved the reproduction rate from 3-in-5 launches to 0-in-22 — the probe hid the bug it was measuring. The published signals are safe to leave on permanently (deduped to transitions, nothing per frame), so wire *those* and reproduce, instead of adding a temporary probe to the paint loop.

## Common mistakes

| Mistake | Reality |
|---|---|
| "Nothing in the log, so forwarding is fine" | Forwarding never raises `"error"` and never touches `"frameDropped"` / `droppedReason`. A clean log is what this failure looks like |
| "Syphon/Spout output works, so the bridge is fine" | Native send and forwarding are independent paths in `handlePaint`. Either can die alone |
| "`forwardFrames()` returned a handle, so it is registered" | A refused registration returns a handle too. Only `active` distinguishes them |
| "Frames stopped, so the library broke" | A paused or static source produces no paint. Check the source first |
| Ranking hypotheses (backpressure, leaks, GPU pressure) before reading `active` + `forwardStatus` | Both signals already exist and are free. Guessing costs a repro cycle each |
| Patching `handlePaint` to count in-flight promises | You are rebuilding, less accurately, the reporting the driver already does |
| Subscribing to nothing and calling forwarding "best-effort" | Best-effort means the *stream* survives failures, not that failures are invisible |

## Related skills

- **`managing-frame-forward-lifecycle`** — registration, teardown, and re-registration after a target window reopens
- **`handling-texture-bridge-failures`** — which calls throw, reject, model a defect, or emit
- **`receiving-shared-textures`** — the renderer half, once `forwardStatus` says `ok` and the canvas is still black
