mod ffi;
pub mod receiver;

use crate::types::{PreviewCallback, RawTextureHandle};
use std::ffi::CString;

pub struct Sender {
    handle: ffi::SpoutBridgeHandle,
    /// Boxed so its address (the C callback context) stays stable. The C side
    /// only invokes it synchronously inside `spout_bridge_send` /
    /// `spout_bridge_poll_preview` (both on this thread), so replacing
    /// or dropping it between calls (and after destroy in `Drop`) is safe.
    preview_callback: Option<Box<PreviewCallback>>,
}

/// `extern "C"` trampoline handed to `spout_bridge_set_preview`. `ctx` is the
/// `*const PreviewCallback` owned by `Sender::preview_callback`.
unsafe extern "C" fn preview_callback_trampoline(
    ctx: *mut std::ffi::c_void,
    rgba: *const u8,
    width: u32,
    height: u32,
) {
    if ctx.is_null() || rgba.is_null() {
        return;
    }
    let len = (width as usize) * (height as usize) * 4;
    let bytes = unsafe { std::slice::from_raw_parts(rgba, len) };
    let callback = unsafe { &*(ctx as *const PreviewCallback) };
    // Never unwind across the FFI boundary.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        callback(bytes, width, height)
    }));
}

// SpoutBridge の内部ポインタはスレッドをまたがないので unsafe impl
unsafe impl Send for Sender {}

impl Sender {
    pub fn new(name: &str, width: u32, height: u32) -> Result<Self, String> {
        let c_name = CString::new(name).map_err(|e| e.to_string())?;
        let handle = unsafe { ffi::spout_bridge_create(c_name.as_ptr(), width, height) };
        if handle.is_null() {
            return Err("Failed to create Spout sender (D3D11 init failed?)".into());
        }
        Ok(Self {
            handle,
            preview_callback: None,
        })
    }

    /// Enable (`Some`) or disable (`None`) the downscaled preview tap. The
    /// preview is the smallest power-of-two mip level of the frame covering
    /// the aspect-fitted `max_width x max_height` bounds.
    pub fn set_preview(
        &mut self,
        max_width: u32,
        max_height: u32,
        callback: Option<PreviewCallback>,
    ) -> Result<(), String> {
        let next = callback.map(Box::new);
        let ret = match &next {
            Some(boxed) => unsafe {
                let ctx = &**boxed as *const PreviewCallback as *mut std::ffi::c_void;
                ffi::spout_bridge_set_preview(
                    self.handle,
                    max_width,
                    max_height,
                    Some(preview_callback_trampoline),
                    ctx,
                )
            },
            None => unsafe {
                ffi::spout_bridge_set_preview(self.handle, 0, 0, None, std::ptr::null_mut())
            },
        };
        if ret != 0 {
            // Refused before touching the bridge: the previous callback is
            // still installed (and still owned here). Callers that want it
            // gone detach with `set_preview(0, 0, None)`.
            return Err("Invalid preview size".into());
        }
        self.preview_callback = next;
        Ok(())
    }

    /// Deliver finished preview readbacks without sending. Returns whether a
    /// readback is still pending (poll again later).
    pub fn poll_preview(&self) -> bool {
        unsafe { ffi::spout_bridge_poll_preview(self.handle) == 1 }
    }

    pub fn send(&self, texture_handle: RawTextureHandle) -> Result<(), String> {
        let ret = unsafe { ffi::spout_bridge_send(self.handle, texture_handle) };
        if ret != 0 {
            Err("Failed to send texture via Spout".into())
        } else {
            Ok(())
        }
    }

    #[allow(dead_code)]
    pub fn resize(&self, width: u32, height: u32) -> Result<(), String> {
        let ret = unsafe { ffi::spout_bridge_resize(self.handle, width, height) };
        if ret != 0 {
            Err("Failed to resize Spout sender".into())
        } else {
            Ok(())
        }
    }

    /// Send raw RGBA buffer data (stub for Windows - not yet implemented)
    pub fn send_rgba(
        &self,
        _data: &[u8],
        _width: u32,
        _height: u32,
        _bytes_per_row: u32,
    ) -> Result<(), String> {
        Err("send_rgba is not yet implemented for Windows/Spout".into())
    }
}

impl Drop for Sender {
    fn drop(&mut self) {
        unsafe {
            ffi::spout_bridge_destroy(self.handle);
        }
    }
}

/// Close a raw NT HANDLE minted by the receiver — exactly once per handle,
/// whether or not it was passed to Electron's `importSharedTexture` (which
/// duplicates its own copy). Returns `Ok(())` on success, or an error
/// describing the failure (invalid handle, CloseHandle failure).
pub fn close_shared_handle(raw_handle: u64) -> Result<(), String> {
    if raw_handle == 0 {
        return Err("Cannot close null NT handle".into());
    }
    let ret = unsafe { ffi::native_close_shared_handle(raw_handle as usize) };
    if ret != 0 {
        return Err("CloseHandle failed for shared NT handle".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(src_w: u32, src_h: u32, max_w: u32, max_h: u32, levels: u32) -> (u32, u32, u32) {
        let (mut level, mut w, mut h) = (0u32, 0u32, 0u32);
        unsafe {
            ffi::spout_preview_pick_mip(src_w, src_h, max_w, max_h, levels, &mut level, &mut w, &mut h)
        };
        (level, w, h)
    }

    fn fit(src_w: u32, src_h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
        let (mut w, mut h) = (0u32, 0u32);
        unsafe { ffi::spout_preview_fit_size(src_w, src_h, max_w, max_h, &mut w, &mut h) };
        (w, h)
    }

    #[test]
    fn preview_fit_size_keeps_aspect_and_never_upscales() {
        assert_eq!(fit(1920, 1080, 384, 216), (384, 216));
        assert_eq!(fit(1080, 1920, 384, 216), (122, 216));
        assert_eq!(fit(320, 180, 384, 216), (320, 180));
        assert_eq!(fit(0, 1080, 384, 216), (0, 0));
    }

    #[test]
    fn preview_pick_mip_chooses_the_smallest_level_covering_the_bounds() {
        // 1920x1080 has 11 levels: 960x540, 480x270, 240x135, ...
        assert_eq!(pick(1920, 1080, 384, 216, 11), (2, 480, 270));
        assert_eq!(pick(1920, 1080, 480, 270, 11), (2, 480, 270));
        assert_eq!(pick(1920, 1080, 960, 540, 11), (1, 960, 540));
        assert_eq!(pick(1920, 1080, 4000, 4000, 11), (0, 1920, 1080));
        // capped by the available mip levels
        assert_eq!(pick(1920, 1080, 16, 9, 2), (1, 960, 540));
        // degenerate bounds keep level 0
        assert_eq!(pick(1920, 1080, 0, 0, 11), (0, 1920, 1080));
    }
}
