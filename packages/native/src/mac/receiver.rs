use super::ffi;
use std::ffi::CString;

/// Push-path frame sink. Invoked on a Metal completion thread; the
/// `SharedIoSurfaceInfo` carries one CFRetain the sink now owns.
pub type FrameCallback = Box<dyn Fn(SharedIoSurfaceInfo) + Send + Sync>;

pub struct Receiver {
    handle: Option<ffi::SyphonReceiverHandle>,
    /// Boxed twice so the C side gets a thin pointer. Freed only after the C
    /// side has been told to stop calling it (unsubscribe or destroy).
    frame_callback: Option<Box<FrameCallback>>,
}

/// `extern "C"` trampoline handed to `syphon_receiver_set_frame_callback`.
/// `ctx` is the `*const FrameCallback` owned by `Receiver::frame_callback`.
unsafe extern "C" fn frame_callback_trampoline(
    ctx: *mut std::ffi::c_void,
    iosurface: *mut std::ffi::c_void,
    width: u32,
    height: u32,
    pixel_format_code: u32,
) {
    let info = SharedIoSurfaceInfo {
        iosurface_ptr: iosurface as u64,
        width,
        height,
        pixel_format_code,
    };
    let callback = unsafe { &*(ctx as *const FrameCallback) };
    // Never unwind across the FFI boundary. A panicking sink may already have
    // passed the surface on, so leaking its retain is the safe choice over a
    // possible double CFRelease.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(info)));
}

/// Metadata + raw IOSurfaceRef pointer for a Syphon frame received as a shared
/// GPU texture.
///
/// `iosurface_ptr` is CFRetained. Ownership transfers to the caller, who must
/// `CFRelease` it exactly once (via `close_shared_iosurface`) — also after
/// passing it to Electron's `importSharedTexture`, which takes its own retain
/// instead of adopting this one.
#[derive(Debug)]
pub struct SharedIoSurfaceInfo {
    pub iosurface_ptr: u64,
    pub width: u32,
    pub height: u32,
    /// 0 = bgra, 1 = rgba, 2 = rgbaf16. See [`pixel_format_string`].
    pub pixel_format_code: u32,
}

impl SharedIoSurfaceInfo {
    /// Convert the numeric code to an Electron-compatible pixel format string.
    pub fn pixel_format_string(&self) -> String {
        match self.pixel_format_code {
            1 => "rgba".to_string(),
            2 => "rgbaf16".to_string(),
            _ => "bgra".to_string(),
        }
    }
}

/// Decode a return value from `syphon_receiver_receive_shared_iosurface` into a
/// Rust-shaped `Result`. Kept as a free function so it can be unit tested
/// without standing up a real Syphon server.
///
/// Return codes — kept in lockstep with the Windows
/// `spout_receiver_receive_shared_texture` table:
/// - `0`  — frame received successfully
/// - `1`  — no new frame (caller polls again)
/// - `2`  — dimensions or pixel format changed; staging was just (re)allocated
///          and no frame was blitted yet. Caller polls again next tick.
/// - `-1` — receiver is not connected (sender disconnected or never appeared)
/// - `-2` — Syphon texture is not IOSurface-backed (should not happen in
///          practice — Syphon vends IOSurface-backed textures)
/// - `-3` — texture pixel format is not one we map to an Electron-compatible
///          string (`bgra` / `rgba` / `rgbaf16`)
fn decode_iosurface_return(
    ret: i32,
    iosurface_ptr: u64,
    width: u32,
    height: u32,
    pixel_format: u32,
) -> Result<Option<SharedIoSurfaceInfo>, String> {
    match ret {
        0 => Ok(Some(SharedIoSurfaceInfo {
            iosurface_ptr,
            width,
            height,
            pixel_format_code: pixel_format,
        })),
        1 | 2 => Ok(None),
        -1 => Err(
            "Shared texture receiver is not connected (sender disconnected or never appeared)"
                .into(),
        ),
        -2 => Err("Syphon texture is not IOSurface-backed".into()),
        -3 => Err("Syphon texture pixel format is not supported".into()),
        _ => Ok(None),
    }
}

unsafe impl Send for Receiver {}

impl Receiver {
    pub fn new(
        server_uuid: Option<&str>,
        server_name: Option<&str>,
        app_name: Option<&str>,
    ) -> Result<Self, String> {
        let c_uuid = server_uuid
            .map(|s| CString::new(s).map_err(|e| e.to_string()))
            .transpose()?;
        let c_name = server_name
            .map(|s| CString::new(s).map_err(|e| e.to_string()))
            .transpose()?;
        let c_app = app_name
            .map(|s| CString::new(s).map_err(|e| e.to_string()))
            .transpose()?;

        let handle = unsafe {
            ffi::syphon_receiver_create(
                c_uuid.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
                c_name.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
                c_app.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
            )
        };

        if handle.is_null() {
            return Err("Failed to create Syphon receiver (no matching server?)".into());
        }

        Ok(Self {
            handle: Some(handle),
            frame_callback: None,
        })
    }

    pub fn destroy(&mut self) {
        if let Some(h) = self.handle.take() {
            // Destroy flips the bridge into shutdown under its callback mutex
            // and waits for in-flight staging, so once it returns no
            // trampoline call can be running or start — only then is it safe
            // to free the boxed callback.
            unsafe {
                ffi::syphon_receiver_destroy(h);
            }
        }
        self.frame_callback = None;
    }

    /// Subscribe (`Some`) or unsubscribe (`None`) the push path. Replacing an
    /// existing callback swaps it atomically on the C side before the old one
    /// is freed. No-op after `destroy`.
    pub fn set_frame_callback(&mut self, callback: Option<FrameCallback>) {
        let Some(h) = self.handle else {
            return;
        };
        let next = callback.map(Box::new);
        match &next {
            Some(boxed) => unsafe {
                let ctx = &**boxed as *const FrameCallback as *mut std::ffi::c_void;
                ffi::syphon_receiver_set_frame_callback(h, Some(frame_callback_trampoline), ctx);
            },
            None => unsafe {
                ffi::syphon_receiver_set_frame_callback(h, None, std::ptr::null_mut());
            },
        }
        // The C setter takes the same mutex the completion handler holds while
        // invoking the callback, so the previous callback is no longer running
        // and can be dropped here.
        self.frame_callback = next;
    }

    pub fn has_new_frame(&self) -> bool {
        match self.handle {
            Some(h) => unsafe { ffi::syphon_receiver_has_new_frame(h) != 0 },
            None => false,
        }
    }

    pub fn receive_rgba(&self) -> Result<Option<(Vec<u8>, u32, u32)>, String> {
        let handle = match self.handle {
            Some(h) => h,
            None => return Ok(None),
        };

        let mut width: u32 = 0;
        let mut height: u32 = 0;

        // Use cached dimensions to pre-allocate, or default to 1080p on first call.
        let cached_w = self.width() as usize;
        let cached_h = self.height() as usize;
        let alloc_size = if cached_w > 0 && cached_h > 0 {
            cached_w * cached_h * 4
        } else {
            // First call: no cached dimensions yet. Allocate 1080p as default.
            1920 * 1080 * 4
        };
        let mut buffer: Vec<u8> = vec![0u8; alloc_size];

        let ret = unsafe {
            ffi::syphon_receiver_receive_rgba(
                handle,
                buffer.as_mut_ptr(),
                alloc_size as u32,
                &mut width,
                &mut height,
            )
        };

        // C API return codes:
        //  0 = frame received
        //  1 = no new frame (poll again)
        //  2 = buffer too small — dimensions updated, next poll will allocate correctly
        // -1 = not connected (sender disconnected or never appeared)
        match ret {
            0 => {
                let actual_size = (width as usize) * (height as usize) * 4;
                buffer.truncate(actual_size);
                Ok(Some((buffer, width, height)))
            }
            1 | 2 => Ok(None), // No new frame or buffer too small — next poll uses updated dimensions
            -1 => Err(
                "Shared texture receiver is not connected (sender disconnected or never appeared)"
                    .into(),
            ),
            _ => Ok(None),
        }
    }

    /// Receive the current frame as an IOSurfaceRef (zero-copy for GPU consumers).
    ///
    /// Returns `Ok(Some(info))` on success. The caller owns `info.iosurface_ptr`
    /// and must `CFRelease` it exactly once, whether or not it was passed to
    /// Electron's `importSharedTexture` (which retains its own reference).
    pub fn receive_shared_iosurface(&self) -> Result<Option<SharedIoSurfaceInfo>, String> {
        let handle = match self.handle {
            Some(h) => h,
            None => return Ok(None),
        };

        let mut iosurface: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut width: u32 = 0;
        let mut height: u32 = 0;
        let mut pixel_format: u32 = 0;

        let ret = unsafe {
            ffi::syphon_receiver_receive_shared_iosurface(
                handle,
                &mut iosurface,
                &mut width,
                &mut height,
                &mut pixel_format,
            )
        };

        decode_iosurface_return(ret, iosurface as u64, width, height, pixel_format)
    }

    pub fn is_valid(&self) -> bool {
        match self.handle {
            Some(h) => unsafe { ffi::syphon_receiver_is_valid(h) != 0 },
            None => false,
        }
    }

    pub fn width(&self) -> u32 {
        match self.handle {
            Some(h) => unsafe { ffi::syphon_receiver_get_width(h) },
            None => 0,
        }
    }

    pub fn height(&self) -> u32 {
        match self.handle {
            Some(h) => unsafe { ffi::syphon_receiver_get_height(h) },
            None => 0,
        }
    }

    /// Toggle the receive-side Y-flip pass. See
    /// `syphon_receiver_set_flip_y` for the semantics — `true` (default)
    /// applies the fullscreen Y-flip render pipeline; `false` falls back to
    /// a straight blit that preserves the upstream Syphon orientation.
    pub fn set_flip_y(&self, flip: bool) {
        if let Some(h) = self.handle {
            unsafe { ffi::syphon_receiver_set_flip_y(h, if flip { 1 } else { 0 }) };
        }
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        self.destroy();
    }
}

/// List available Syphon servers as a JSON string.
pub fn list_servers_json() -> Result<String, String> {
    unsafe {
        let ptr = ffi::syphon_discovery_list_servers();
        if ptr.is_null() {
            return Err("Failed to list Syphon servers".into());
        }
        // Always free the C string, even if UTF-8 conversion fails
        let result = std::ffi::CStr::from_ptr(ptr)
            .to_str()
            .map(|s| s.to_string())
            .map_err(|e| e.to_string());
        ffi::syphon_discovery_free_string(ptr);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- SharedIoSurfaceInfo::pixel_format_string ----

    #[test]
    fn pixel_format_string_bgra_for_code_0() {
        let info = SharedIoSurfaceInfo {
            iosurface_ptr: 0,
            width: 0,
            height: 0,
            pixel_format_code: 0,
        };
        assert_eq!(info.pixel_format_string(), "bgra");
    }

    #[test]
    fn pixel_format_string_rgba_for_code_1() {
        let info = SharedIoSurfaceInfo {
            iosurface_ptr: 0,
            width: 0,
            height: 0,
            pixel_format_code: 1,
        };
        assert_eq!(info.pixel_format_string(), "rgba");
    }

    #[test]
    fn pixel_format_string_rgbaf16_for_code_2() {
        let info = SharedIoSurfaceInfo {
            iosurface_ptr: 0,
            width: 0,
            height: 0,
            pixel_format_code: 2,
        };
        assert_eq!(info.pixel_format_string(), "rgbaf16");
    }

    #[test]
    fn pixel_format_string_unknown_defaults_to_bgra() {
        let info = SharedIoSurfaceInfo {
            iosurface_ptr: 0,
            width: 0,
            height: 0,
            pixel_format_code: 99,
        };
        assert_eq!(info.pixel_format_string(), "bgra");
    }

    // ---- decode_iosurface_return: maps the C return-code table into a Rust
    // Result<Option<…>>. Each branch is the contract the C bridge promises
    // — keep these in lockstep with the codes documented at
    // syphon_bridge.h:syphon_receiver_receive_shared_iosurface.

    #[test]
    fn decode_iosurface_return_code_0_returns_some_info_with_handle() {
        let result = decode_iosurface_return(0, 0xdead_beef_0000_1234, 1920, 1080, 1);
        let info = result.expect("ret=0 must not error").expect("ret=0 must yield Some");
        assert_eq!(info.iosurface_ptr, 0xdead_beef_0000_1234);
        assert_eq!(info.width, 1920);
        assert_eq!(info.height, 1080);
        assert_eq!(info.pixel_format_code, 1);
        assert_eq!(info.pixel_format_string(), "rgba");
    }

    #[test]
    fn decode_iosurface_return_code_1_returns_none_no_new_frame() {
        let result = decode_iosurface_return(1, 0, 0, 0, 0);
        assert!(result.expect("ret=1 must not error").is_none());
    }

    #[test]
    fn decode_iosurface_return_code_2_returns_none_dimensions_changed() {
        // Mirrors Windows: ret=2 means the staging texture was just resized
        // and the caller should poll again on the next tick.
        let result = decode_iosurface_return(2, 0, 1920, 1080, 0);
        assert!(result.expect("ret=2 must not error").is_none());
    }

    #[test]
    fn decode_iosurface_return_code_minus_1_returns_err_not_connected() {
        let result = decode_iosurface_return(-1, 0, 0, 0, 0);
        let err = result.expect_err("ret=-1 must be Err");
        assert!(err.contains("not connected"), "got: {err}");
    }

    #[test]
    fn decode_iosurface_return_code_minus_2_returns_err_not_iosurface_backed() {
        let result = decode_iosurface_return(-2, 0, 0, 0, 0);
        let err = result.expect_err("ret=-2 must be Err");
        assert!(err.contains("IOSurface-backed"), "got: {err}");
    }

    #[test]
    fn decode_iosurface_return_code_minus_3_returns_err_unsupported_pixel_format() {
        // New code: aligns with Windows where dxgi_format_to_pixel_format
        // surfaces an Err on unknown formats. Prevents silently lying about
        // a texture's layout to Electron's importSharedTexture.
        let result = decode_iosurface_return(-3, 0, 0, 0, 0);
        let err = result.expect_err("ret=-3 must be Err");
        assert!(err.contains("pixel format"), "got: {err}");
    }

    #[test]
    fn decode_iosurface_return_code_unknown_returns_none_safely() {
        // Unknown codes degrade to "no frame" rather than panicking — defensive
        // for forward compatibility if the C side adds a new code we haven't
        // wired through yet.
        let result = decode_iosurface_return(99, 0, 0, 0, 0);
        assert!(result.expect("unknown code must not error").is_none());
    }

    // ---- syphon_ring_pick_slot: pure slot picker for the push staging ring.
    // A slot is free when only the bridge holds it (normalized retain count
    // == 1) and no staging command buffer is writing it.

    fn pick_slot(counts: &[u32], busy: &[u8]) -> i32 {
        assert_eq!(counts.len(), busy.len());
        unsafe { ffi::syphon_ring_pick_slot(counts.as_ptr(), busy.as_ptr(), counts.len() as u32) }
    }

    #[test]
    fn ring_pick_slot_returns_first_free_slot() {
        assert_eq!(pick_slot(&[2, 1, 1], &[0, 0, 0]), 1);
    }

    #[test]
    fn ring_pick_slot_skips_gpu_busy_slot() {
        assert_eq!(pick_slot(&[1, 1, 1], &[1, 0, 0]), 1);
    }

    #[test]
    fn ring_pick_slot_returns_minus_one_when_all_held() {
        assert_eq!(pick_slot(&[2, 3, 2], &[0, 0, 0]), -1);
    }

    #[test]
    fn ring_pick_slot_empty_ring() {
        assert_eq!(pick_slot(&[], &[]), -1);
    }

    // ---- Pixel format utility tests ----

    #[test]
    fn convert_bgra_to_rgba_single_pixel() {
        let bgra: [u8; 4] = [10, 20, 30, 255]; // B=10, G=20, R=30, A=255
        let mut rgba = [0u8; 4];
        unsafe { ffi::syphon_convert_bgra_to_rgba(bgra.as_ptr(), rgba.as_mut_ptr(), 1) };
        assert_eq!(rgba, [30, 20, 10, 255]); // R=30, G=20, B=10, A=255
    }

    #[test]
    fn convert_bgra_to_rgba_multiple_pixels() {
        let bgra: [u8; 12] = [
            0, 128, 255, 200, // pixel 0: B=0, G=128, R=255, A=200
            50, 100, 150, 0,  // pixel 1: B=50, G=100, R=150, A=0
            1, 2, 3, 4,       // pixel 2: B=1, G=2, R=3, A=4
        ];
        let mut rgba = [0u8; 12];
        unsafe { ffi::syphon_convert_bgra_to_rgba(bgra.as_ptr(), rgba.as_mut_ptr(), 3) };
        assert_eq!(
            rgba,
            [
                255, 128, 0, 200,  // R=255, G=128, B=0, A=200
                150, 100, 50, 0,   // R=150, G=100, B=50, A=0
                3, 2, 1, 4,        // R=3, G=2, B=1, A=4
            ]
        );
    }

    #[test]
    fn convert_bgra_to_rgba_zero_pixels() {
        let bgra: [u8; 0] = [];
        let mut rgba: [u8; 0] = [];
        // Should not crash
        unsafe { ffi::syphon_convert_bgra_to_rgba(bgra.as_ptr(), rgba.as_mut_ptr(), 0) };
    }

    #[test]
    fn convert_bgra_to_rgba_in_place() {
        let mut data: [u8; 8] = [
            10, 20, 30, 40,  // pixel 0: B=10, G=20, R=30, A=40
            50, 60, 70, 80,  // pixel 1: B=50, G=60, R=70, A=80
        ];
        unsafe {
            ffi::syphon_convert_bgra_to_rgba(data.as_ptr(), data.as_mut_ptr(), 2);
        }
        assert_eq!(data, [30, 20, 10, 40, 70, 60, 50, 80]);
    }

    #[test]
    fn convert_bgra_to_rgba_preserves_alpha() {
        // Test with fully transparent and fully opaque
        let bgra: [u8; 8] = [
            100, 100, 100, 0,    // fully transparent
            100, 100, 100, 255,  // fully opaque
        ];
        let mut rgba = [0u8; 8];
        unsafe { ffi::syphon_convert_bgra_to_rgba(bgra.as_ptr(), rgba.as_mut_ptr(), 2) };
        assert_eq!(rgba[3], 0);   // alpha preserved as 0
        assert_eq!(rgba[7], 255); // alpha preserved as 255
    }

    // OSType FourCC values used in IOSurface
    const FOURCC_BGRA: u32 = u32::from_be_bytes(*b"BGRA");
    const FOURCC_RGBA: u32 = u32::from_be_bytes(*b"RGBA");

    #[test]
    fn map_pixel_format_bgra_to_metal_bgra() {
        let result = unsafe { ffi::syphon_map_pixel_format(FOURCC_BGRA) };
        assert_eq!(result, 80); // MTLPixelFormatBGRA8Unorm
    }

    #[test]
    fn map_pixel_format_rgba_to_metal_rgba() {
        let result = unsafe { ffi::syphon_map_pixel_format(FOURCC_RGBA) };
        assert_eq!(result, 70); // MTLPixelFormatRGBA8Unorm
    }

    #[test]
    fn map_pixel_format_unknown_defaults_to_bgra() {
        let result = unsafe { ffi::syphon_map_pixel_format(0x12345678) };
        assert_eq!(result, 80); // MTLPixelFormatBGRA8Unorm (safe default)
    }

    #[test]
    fn map_pixel_format_zero_defaults_to_bgra() {
        let result = unsafe { ffi::syphon_map_pixel_format(0) };
        assert_eq!(result, 80); // MTLPixelFormatBGRA8Unorm
    }

    #[test]
    fn convert_bgra_to_rgba_roundtrip() {
        // BGRA→RGBA→BGRA should give back the original
        let original: [u8; 8] = [10, 20, 30, 40, 50, 60, 70, 80];
        let mut intermediate = [0u8; 8];
        let mut roundtrip = [0u8; 8];
        unsafe {
            ffi::syphon_convert_bgra_to_rgba(original.as_ptr(), intermediate.as_mut_ptr(), 2);
            // Apply again: RGBA→BGRA (same swap operation)
            ffi::syphon_convert_bgra_to_rgba(intermediate.as_ptr(), roundtrip.as_mut_ptr(), 2);
        }
        assert_eq!(roundtrip, original);
    }
}
