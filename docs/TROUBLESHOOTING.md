# Troubleshooting

## Paint event not firing

- Ensure `win.webContents.setFrameRate(60)` is set
- Paint events fire even with `show: false`
- Verify that a `requestAnimationFrame` loop is running in the renderer/worker

## Black texture output

- **DPR / Retina size mismatch (most common).** **Electron ≤ 40:** on a Retina display or under Windows display scaling, the real framebuffer is `width × height × scaleFactor`, so a sender declared at the logical size disagrees with it and the receiver goes black/garbled. Use `createTextureBridge({ pixelExact: true })`, or — on the low-level core path — declare the sender at the true framebuffer size or neutralize DPR yourself. **Electron ≥ 41:** `createTextureBridge` pins the OSR device scale factor to `1`, so this mismatch no longer occurs — see [Migration: Electron 42 / OSR device scale](MIGRATION.md#migration-electron-42--osr-device-scale); on the low-level core path, pass `offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }` yourself. See the [Retina/DPI warning](SENDING.md#macos-retina-and-windows-dpi-scaling).
- **Isolate Electron vs. the bridge** with the [no-Electron sanity check](SENDING.md#minimal-sanity-check-no-electron) — if `sendRgbaBuffer` shows up in your VJ app, the native side is fine and the problem is in the Electron OSR path.
- `preserveDrawingBuffer` is not needed (Chromium compositor reads directly)
- Check pixel format mismatch: Chromium outputs BGRA, ensure the receiver expects BGRA
- Subscribe to `bridge.on("frameDropped", ...)` (or check the return value of
  `sendTextureFromPaintEvent`) — a persistent `no-nt-handle` / `no-io-surface`
  reason means Chromium is not delivering a shareable GPU handle, which
  otherwise manifests only as black output.

## Syphon receiver not showing output (macOS)

- Verify `vendor/Syphon.framework` exists and was built correctly
- Clear Gatekeeper quarantine: `xattr -dr com.apple.quarantine vendor/Syphon.framework`
- Check Console.app for error logs

## Spout receiver not showing output (Windows)

- Verify Spout2 is installed on the system
- Ensure GPU drivers are up to date
- DirectX 11 compatible GPU is required

## Zero-copy shared-texture receiver

- **Requires Electron 40+** — uses the `sharedTexture.importSharedTexture` / `sendSharedTexture` / `setSharedTextureReceiver` module. Older Electron will throw at import time.
- **`listSenders()` shows `<sender>_1` suffixes.** A previous sender process of the same name was killed uncleanly and its shared-memory directory entry is lingering. Start (or restart) the real sender — it will either reclaim the clean name or the stale suffix will go away on its own on the next publisher cycle.
- **Per-frame handle leak (NT HANDLE count / IOSurface memory grows steadily).** If you poll `receiveSharedTexture()` directly, call `closeNativeHandle(frame.handle)` exactly once on **every** path — including after a successful `sharedTexture.importSharedTexture`, which never takes ownership of the handle (it keeps its own duplicated / retained reference), and on "target was destroyed", "unknown pixel format", and "I decided to drop this frame". `createSharedTextureReceiver` does this for you.
- **Windows staging texture.** The receiver creates its staging texture with `MISC_SHARED_NTHANDLE | MISC_SHARED` (no keyed mutex), so consumers do not need to `AcquireSync` per frame — Electron imports it directly.

## Freezing / paint events stop

- **Always call `texture.release()`** after processing. The texture pool is small (a few frames). Failing to release will exhaust the pool and stall the paint event pipeline.
- When using `createTextureBridge()`, this is handled automatically.
- When using the low-level core API, use `try/finally`:

```typescript
win.webContents.on("paint", (event) => {
  const texture = event.texture;
  if (!texture) return;
  try {
    sendTextureFromPaintEvent(sender, texture.textureInfo);
  } finally {
    texture.release?.();
  }
});
```

