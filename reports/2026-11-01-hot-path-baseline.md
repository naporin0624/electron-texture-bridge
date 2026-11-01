# Hot-path baseline (macOS / Syphon, 2026-11-01)

Environment: Apple Silicon, macOS 26 (Darwin 25.4), Electron 40.2.1 main process, native addon rebuilt from `main@7f7d589`.
Bench scripts live outside the repo (session scratchpad): Electron main runs a TextureSender (RGBA upload, only to drive frames) → `TextureReceiver.receiveSharedTexture()` → second `TextureSender.sendSurface()` → `closeNativeHandle()`.

## Native call cost (main-thread blocking time)

| Path | 1920x1080 | 3840x2160 |
| --- | --- | --- |
| `sendSurface` (paint → Syphon) | mean 0.026 ms / p99 0.046 ms | mean 0.034 ms / p99 0.063 ms |
| `receiveSharedTexture` flipY=true | mean ≈0.55 ms / p99 ≈1.4 ms | mean 1.41 ms / p99 2.39 ms |
| `receiveSharedTexture` flipY=false | mean ≈0.61 ms / p99 ≈1.3 ms | — |

- Send path is already effectively free on the CPU: Metal texture wrap of the IOSurface + async command buffer commit.
- Receive path cost is dominated by `[cmdBuf waitUntilCompleted]` in `syphon_receiver_receive_shared_iosurface` — a synchronous GPU round-trip on the Electron main thread per frame per receiver. It scales with pixel count. flipY (render pass) vs blit makes no difference.
- Multiviewer impact: N receivers × cost per tick. 16 × 1080p ≈ 9 ms, 16 × 4K ≈ 22 ms of main-thread blocking per frame.

## Poll-induced latency

`createSharedTextureReceiver` drives the receiver with `setInterval(pollIntervalMs)` (default 16, example uses 8). Theoretical added latency is uniform in `[0, interval]` → mean 4–8 ms, plus timer jitter.

A headless measurement could not reproduce this: with no windows open, Electron's main runloop only woke on Syphon frame notifications, so `setInterval(8)` fired 300 times over 300 frames (≈60 Hz, not 125 Hz) and latency collapsed to ≈1 ms for every interval. This is a bench artifact, not a production guarantee.

## Zero-copy status

- Paint → Syphon: GPU only (IOSurface wrapped as MTLTexture; Syphon's own publish blit).
- Syphon → Electron receive: GPU only (one GPU→GPU copy into a receiver-owned staging IOSurface — required because Syphon recycles its pool surfaces).
- No CPU readback on either hot path. `sendRgbaBuffer` / `receiveFrame` are CPU paths and out of scope.

## Optimization targets (ordered)

1. Remove the synchronous GPU wait from the receive path (async completion + staging ring).
2. Push frames to JS from Syphon's `newFrameHandler` (napi ThreadsafeFunction) instead of polling — removes poll latency and empty polls. Required together with (1): async completion under polling would add one full poll interval.
3. Deliver the first frame after a resize immediately instead of returning code 2 and dropping it.

Windows (Spout) has the same single-staging shape but could not be measured on this machine; it is out of scope for this pass.

## After (perf/zero-copy-hot-path: async staging ring + push delivery)

Same machine, same day, Electron 40.2.1 main process, `pnpm build:native` from the working tree.
Bench is now in-repo: `packages/native/bench/hot-path.mjs` (`MODE=poll|push`, `W`/`H`; producer for push mode in `bench/producer-worker.cjs`).

```bash
MODE=poll W=1920 H=1080 packages/example/node_modules/.bin/electron packages/native/bench/hot-path.mjs
MODE=push W=3840 H=2160 packages/example/node_modules/.bin/electron packages/native/bench/hot-path.mjs
```

### Main-thread time per frame per receiver

| Path | 1920x1080 | 3840x2160 |
| --- | --- | --- |
| Before: `receiveSharedTexture` (poll, sync GPU wait) | mean 0.87–1.21 ms / p99 1.37–1.78 ms | mean 1.67 ms / p99 2.33–2.54 ms |
| After, poll path (unchanged by design) | mean 0.95–1.15 ms / p99 1.47–1.57 ms | mean 1.61–1.81 ms / p99 2.40–2.48 ms |
| After, push: whole `onSharedTexture` callback incl. `sendSurface` + `closeNativeHandle` | **mean 0.045–0.057 ms / p99 0.09–0.13 ms** | **mean 0.049 ms / p99 0.091 ms** |
| `sendSurface` (for reference) | mean 0.024 ms / p99 0.069 ms | mean 0.022 ms / p99 0.054 ms |

- "Before" here is an A/B re-run in the same session: `HEAD` (7f7d589) built in a scratch worktree vs the working tree, alternating runs. The poll path is within noise of `HEAD`. Both are higher than the 0.55 ms in the first table above, which was measured under different machine load; compare rows inside this table only.
- Push mode takes the GPU wait off the main thread: ~20x (1080p) to ~35x (4K) less main-thread time per frame per receiver, and it no longer scales with pixel count. 16 receivers ≈ 0.8 ms per tick instead of 15–30 ms.
- The callback time does not include the napi ThreadsafeFunction dispatch into the callback; it is the JS-visible cost.

### Publish → delivery latency (1920x1080, worker-thread producer at ~60 Hz)

| Delivery | mean | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| Before: `setInterval(8)` + `receiveSharedTexture` | 7.05 ms | 7.33 ms | 11.48 ms | 14.37 ms |
| Before: `setInterval(16)` (library default) | 8.22 ms | 7.92 ms | 16.42 ms | 17.87 ms |
| Before: ideal poll (spin on `hasNewFrame` via `setImmediate`) | 1.49 ms | 1.46 ms | 2.29 ms | 5.61 ms |
| After: push (`onSharedTexture`) | 1.47–1.96 ms | 1.43–2.02 ms | 2.20–2.72 ms | 3.7–7.6 ms |

At 3840x2160 push latency was mean 2.49 ms / p95 4.27 ms (one run).

- Push matches the ideal-spin floor without burning the main thread, and removes the 0–interval poll delay (≈5.5–6.5 ms mean saved vs the 8/16 ms intervals).
- Headless-timer caveat: the earlier "≈1 ms for every interval" result did not reproduce in this session. The same scratchpad `latency.mjs` now fires `setInterval(8)` at ~125 Hz (≈530 polls over 300 frames) and shows the expected interval-bound latency, with or without `powerSaveBlocker` (mean 6.2–6.9 ms either way), so the cause of the earlier collapse is unknown. All numbers here are headless (no BrowserWindow); under a busy renderer the poll timer jitters further, while push is driven by Syphon's `newFrameHandler`.
- Push smoke checks in the bench: 0 callbacks after `stop()`, `stop()` returns in 0.8–1.3 ms while frames are still flowing, `onSharedTexture` after `stop()` throws `"TextureReceiver has been stopped"`.

### Known issue found in the manual check (push mode in the example multiviewer)

The bench closes each handle with `closeNativeHandle`, so it never hits this. In the example app, push-mode Syphon slots deliver 3 frames and then stall (`arrival 0.0 fps`, log: `push: all 3 ring slots still held downstream`). Root cause, checked with a standalone Electron script and an IOSurface probe addon (both in the session scratchpad):

- Electron 40.2.1 `sharedTexture.importSharedTexture({ ioSurface })` does **not** adopt the caller's IOSurface retain. `CFGetRetainCount` is the same before import, after import and after `imported.release()` (and after GC). The per-frame retain minted by the native receiver is therefore never released when the handle goes through `importSharedTexture`.
- The push ring treats a slot as free only when its retain count is back at baseline, so after 3 frames every slot looks held forever.
- Calling `closeNativeHandle(frame.handle)` right after a successful `importSharedTexture` keeps frames flowing (237/237 frames delivered for import-only, send, and send with a renderer-held `VideoFrame` clone). `IOSurfaceIsInUse` is true while Electron uses the surface, so the ring's in-use guard still protects slots that are being read.
- The poll path has the same per-frame retain leak on the single staging IOSurface, and it is already on `main` (`CFRetain(bridge->sharedStagingIOSurface)` per `receiveSharedTexture`). It does not stall because that path never checks the retain count, but the staging surface is never freed after a resize or `stop()`.
