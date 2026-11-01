# Shared-Texture Receiver Fan-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One native Syphon/Spout receive per source, delivered to many renderer targets, so N viewers of the same source stop paying N native staging copies and N imports per frame.

**Architecture:** `SharedTextureReceiverBridge` gains `forwardFrames(target, options)` with the same shape as `TextureBridge.forwardFrames`. Each frame is imported once, sent to every live target, and the main reference is released once after every send for that frame has settled. Each target has its own latest-wins slot, so a slow renderer drops frames without slowing the others.

**Tech Stack:** TypeScript, neverthrow, vitest, Electron 40 `sharedTexture`, napi addon (unchanged).

**Spec:** Decisions made with the user on 2026-11-02 (this file is the spec):
- API: `forwardFrames` on the receiver bridge (option "forwardFrames を追加").
- Slow target: per-target independent latest-wins (option "配信先ごとに独立").
- Scope: library + example multiviewer + bench re-measure + Windows covered (platform-smoke run manually).
- Evidence: `reports/2026-11-01-e2e-latency.md` — publish→callback grows with N (2.4 → 4.1 ms at 4K N=16 without drawing) and 4K × N=16 saturates.

## Global Constraints

- Electron 40.2.1 semantics (verified in `lib/browser/api/shared-texture.ts` @ v40.2.1): one imported texture may be passed to `sendSharedTexture` for several frames; Electron refcounts renderer frames. The main reference (`imported.release()`) must be dropped **only after every in-flight send of that imported texture has settled** — releasing earlier frees the texture when the renderer refcount is still 0.
- The native handle is closed exactly once right after `importSharedTexture` (success or throw), as today (`_prepare`).
- Backward compatible: existing `createSharedTextureReceiver({ target, extraArgs })` behaves exactly as before (its `target` becomes the "primary" forward). `target` becomes optional so a receiver can be target-less and use only `forwardFrames`.
- Project rules: arrow functions / class method shorthand, no `let`/IIFE/`!`/`forEach`/`any`, neverthrow Result internal only (producers return Result, drivers `.match`), no barrels, `satisfies` over `as`, acronyms all-caps.
- `pnpm lint && pnpm typecheck` and renderer/core vitest must pass. Do not commit (the user commits after difit review).

## Review Focus

1. A target destroyed while one of its sends is in flight → imported texture still released exactly once, other targets keep receiving.
2. `forward.dispose()` while its send is in flight and a pending frame is queued → pending frame's reference dropped, no further sends to that target.
3. `receiver.dispose()`/`stop()` with several targets mid-flight → every imported texture released once, every pending handle closed, no sends after return.
4. Zero targets (target-less receiver with every forward disposed) → frames are not imported at all (handle closed immediately), no leak.
5. One target's send rejects repeatedly → that target's status/err path only; circuit breaker semantics for the primary target unchanged; other targets unaffected.

---

### Task 1: `forwardFrames` on SharedTextureReceiverBridge

**Files:**
- Modify: `packages/renderer/src/shared-texture-receiver.ts`
- Modify: `packages/renderer/src/types.ts` only if the shared `FrameForward` / `FrameForwardOptions` / `ForwardStatus` types need reuse (prefer reuse over new types)
- Test: `packages/renderer/src/__tests__/shared-texture-receiver.test.ts` (and/or a new `shared-texture-receiver-fan-out.test.ts`)
- Docs: `docs/API.md`, `docs/RECEIVING.md`, `docs/ja/` counterparts

**Interfaces:**
- Produces: `SharedTextureReceiverBridge.forwardFrames(target: WebContents, options?: FrameForwardOptions): FrameForward` — same contract as `TextureBridge.forwardFrames` (idempotent `dispose()`, `active`, auto-unregister on target `"destroyed"`, inert handle after receiver dispose or for an already-destroyed target, `onStatus` best-effort).
- `SharedTextureReceiverOptions.target` becomes optional.

- [ ] Step 1: Write failing tests (mock `electron.sharedTexture` like the existing suite):
  - two targets → `importSharedTexture` called once per frame, `sendSharedTexture` once per target, `imported.release()` once, after both sends resolve.
  - slow target (send pending) + fast target → fast target receives every frame; slow target receives only the latest frame after its send settles; superseded imported textures released once.
  - Review Focus 1–5 each as a test.
  - legacy single-`target` path unchanged (existing tests keep passing untouched).
- [ ] Step 2: Run, confirm failures.
- [ ] Step 3: Implement. Suggested shape: a per-frame refcount wrapper around the imported texture (`retain`/`release` → `imported.release()` at zero); per-target state `{ inFlight, pending }`; the primary `target` is just the first forward entry so there is one delivery path. FPS/`"fps"` event counts frames delivered to at least one target. Circuit breaker counts import/receive errors and primary-target send errors as today.
- [ ] Step 4: Tests, `pnpm lint`, `pnpm typecheck` pass.
- [ ] Step 5: Docs updated (API + RECEIVING, en/ja) with a fan-out example.

### Task 2: Example multiviewer shares receivers per source

**Files:** `packages/example/src/main/index.ts`

- [ ] Slots selecting the same Syphon/Spout sender (same `senderName` + `flipY`) share one receiver via `forwardFrames(multiviewerWindow.webContents, { extraArgs: [slot] })`; the receiver is disposed when its last slot disconnects. flipY toggle re-keys correctly.
- [ ] `pnpm lint && pnpm typecheck`; start the example briefly to confirm it boots, then kill Electron.

### Task 3: Bench re-measure

**Files:** `packages/renderer/bench/e2e-latency/*`, `reports/2026-11-01-e2e-latency.md`

- [ ] Add `PIPE=F` (one `createSharedTextureReceiver` + N−1 `forwardFrames`) to the bench.
- [ ] Re-run N=1/4/16 × 1080p/4K × `2d`/`webgpu`/`none` for B (before) and F (after); append an "After: fan-out" section with tables and a short conclusion. Kill Electron after each run.

### Task 4: Windows check

- [ ] After pushing the branch: `gh workflow run platform-smoke.yml --ref perf/e2e-latency-bench`, watch, report.
