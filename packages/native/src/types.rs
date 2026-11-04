/// Texture handle from Electron's paint event.
///
/// - Windows: DXGI shared HANDLE (cast to i64)
/// - macOS:   IOSurfaceID (uint32, passed as i64)
pub type RawTextureHandle = i64;

/// Sink for downscaled sender previews: `(rgba, width, height)` with
/// `rgba.len() == width * height * 4`, tightly packed, top row first. The slice
/// is only valid for the duration of the call. Runs on a native thread (macOS:
/// Metal completion thread) or inside `send` (Windows) — must not block.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub type PreviewCallback = Box<dyn Fn(&[u8], u32, u32) + Send + Sync>;
