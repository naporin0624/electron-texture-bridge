# Native Preview Frames + Syphon MTLTexture Cache

Status: implemented on `feat/native-preview-frames` (macOS verified, Windows compile-reviewed only).

## Goal

Cheap thumbnails of each bridge (e.g. 4 decks × 384×216 @ 30 fps) without
Electron's per-frame shared-texture import / sync-token flush / release
round-trip / renderer IOSurface wrap + full-resolution copy.

## Design

1. Native preview tap on `TextureSender` (`setPreview(maxW, maxH, cb | null)`):
   - macOS: downscale (box-filter fragment shader, aspect-fitted size) +
     blit into a Shared `MTLBuffer` ring, encoded on the Syphon publish
     command buffer; delivered from the completion handler. No CPU wait.
   - Windows: CopySubresourceRegion → GenerateMips → covering mip level →
     staging ring; mapped with `DO_NOT_WAIT` on the next send.
   - JS: unref'd TSFN, queue bound 2, `PreviewFrame { data, width, height }`.
2. `TextureBridge.forwardPreviewFrames(target, { width, height, extraArgs, onStatus })`:
   one tap per bridge (oldest registration's bounds), off without registrations,
   re-applied after `resize()`, `preview-unavailable` status when setup fails,
   per-frame `webContents.send(PREVIEW_FRAME_CHANNEL, ...)`.
3. `consumePreviewFrames(ipcRenderer, handlers)` in `/client`.
4. Syphon: cache IOSurface → MTLTexture wrappers (≤16, CFRetained keys,
   invalidated on size/format change and destroy). Spout: not cached —
   Electron's NT handle values can be reused after `release()`.

## Tasks

- [x] mac native preview + cache, Rust tests (orientation/channel order, resize, disable, drop race, cache bound)
- [x] Windows native preview (compile on CI `windows-native-smoke`; Rust cross-checked with `cargo check --target x86_64-pc-windows-msvc`)
- [x] napi `setPreview`
- [x] bridge `forwardPreviewFrames` (TDD: `bridge-preview.test.ts`)
- [x] client `consumePreviewFrames` (TDD: `preview-frame-consumer.test.ts`)
- [x] example Preview Strip window, docs
- [ ] Windows on-device verification
