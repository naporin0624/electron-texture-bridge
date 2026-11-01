use super::ffi;
use std::ffi::CString;

/// Push-path frame sink. Invoked on the receiver's native push worker thread;
/// the `SharedTextureHandleInfo` carries an NT HANDLE the sink now owns.
pub type FrameCallback = Box<dyn Fn(SharedTextureHandleInfo) + Send + Sync>;

pub struct Receiver {
    handle: Option<ffi::SpoutReceiverHandle>,
    buffer: Vec<u8>,
    #[allow(dead_code)]
    sender_name: String,
    /// Boxed twice so the C side gets a thin pointer. Freed only after the C
    /// side has joined the worker that calls it (unsubscribe or destroy).
    frame_callback: Option<Box<FrameCallback>>,
}

/// `extern "C"` trampoline handed to `spout_receiver_set_frame_callback`.
/// `ctx` is the `*const FrameCallback` owned by `Receiver::frame_callback`.
unsafe extern "C" fn frame_callback_trampoline(
    ctx: *mut std::ffi::c_void,
    nt_handle: *mut std::ffi::c_void,
    width: u32,
    height: u32,
    dxgi_format: u32,
) {
    let info = SharedTextureHandleInfo {
        nt_handle: nt_handle as u64,
        width,
        height,
        format: dxgi_format,
    };
    let callback = unsafe { &*(ctx as *const FrameCallback) };
    // Never unwind across the FFI boundary. A panicking sink may already have
    // passed the handle on, so leaking it is the safe choice over a possible
    // double CloseHandle.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(info)));
}

/// Metadata + raw NT handle for a Spout frame received as a shared GPU texture.
///
/// `nt_handle` is a freshly minted kernel handle. Ownership is transferred to
/// the caller, who must close it exactly once (via `close_shared_handle`) —
/// also after passing it to Electron's `sharedTexture.importSharedTexture`,
/// which `DuplicateHandle`s its own copy instead of adopting this one.
pub struct SharedTextureHandleInfo {
    pub nt_handle: u64,
    pub width: u32,
    pub height: u32,
    /// Raw `DXGI_FORMAT` value. 87 = `B8G8R8A8_UNORM` (BGRA), which is what
    /// Spout senders default to.
    pub format: u32,
}

unsafe impl Send for Receiver {}

impl Receiver {
    pub fn new(sender_name: &str) -> Result<Self, String> {
        let c_name = CString::new(sender_name).map_err(|e| e.to_string())?;
        let handle = unsafe { ffi::spout_receiver_create(c_name.as_ptr()) };
        if handle.is_null() {
            return Err("Failed to create Spout receiver".into());
        }
        Ok(Self {
            handle: Some(handle),
            buffer: Vec::new(),
            sender_name: sender_name.to_string(),
            frame_callback: None,
        })
    }

    #[allow(dead_code)]
    pub fn sender_name(&self) -> &str {
        &self.sender_name
    }

    pub fn destroy(&mut self) {
        if let Some(h) = self.handle.take() {
            // Destroy signals the push worker and joins it before releasing
            // anything, so once it returns no trampoline call can be running
            // or start — only then is it safe to free the boxed callback.
            unsafe {
                ffi::spout_receiver_destroy(h);
            }
        }
        self.frame_callback = None;
    }

    /// Subscribe (`Some`) or unsubscribe (`None`) the push path. The C side
    /// stops and joins any running push worker before starting a new one, so
    /// the previous callback is no longer running when this returns and can
    /// be dropped. No-op after `destroy`.
    pub fn set_frame_callback(&mut self, callback: Option<FrameCallback>) {
        let Some(h) = self.handle else {
            return;
        };
        let next = callback.map(Box::new);
        match &next {
            Some(boxed) => unsafe {
                let ctx = &**boxed as *const FrameCallback as *mut std::ffi::c_void;
                ffi::spout_receiver_set_frame_callback(h, Some(frame_callback_trampoline), ctx);
            },
            None => unsafe {
                ffi::spout_receiver_set_frame_callback(h, None, std::ptr::null_mut());
            },
        }
        self.frame_callback = next;
    }

    pub fn has_new_frame(&self) -> bool {
        match self.handle {
            Some(h) => unsafe { ffi::spout_receiver_has_new_frame(h) != 0 },
            None => false,
        }
    }

    pub fn receive_rgba(&mut self) -> Result<Option<(Vec<u8>, u32, u32)>, String> {
        let handle = match self.handle {
            Some(h) => h,
            None => return Ok(None),
        };

        let mut width: u32 = 0;
        let mut height: u32 = 0;

        // Ensure buffer matches current sender dimensions.
        // On first call (dimensions unknown), pass empty buffer — C++ handles nullptr.
        let cached_w = self.width() as usize;
        let cached_h = self.height() as usize;
        let required = cached_w * cached_h * 4;
        if self.buffer.len() != required {
            self.buffer.resize(required, 0);
        }

        let ret = unsafe {
            ffi::spout_receiver_receive_rgba(
                handle,
                self.buffer.as_mut_ptr(),
                self.buffer.len() as u32,
                &mut width,
                &mut height,
            )
        };

        // C API return codes:
        //  0 = frame received
        //  1 = no new frame (poll again)
        //  2 = dimensions changed (next poll will use updated size)
        // -1 = not connected (sender disconnected or never appeared)
        match ret {
            0 => {
                let actual_size = (width as usize) * (height as usize) * 4;
                let frame = self.buffer[..actual_size].to_vec();
                Ok(Some((frame, width, height)))
            }
            1 | 2 => Ok(None),
            -1 => Err(
                "Shared texture receiver is not connected (sender disconnected or never appeared)"
                    .into(),
            ),
            _ => Ok(None),
        }
    }

    /// Receive a frame as a GPU-shared NT-handle texture (zero CPU readback).
    ///
    /// Returns `Ok(Some(info))` on success. The caller owns `info.nt_handle`
    /// and must close it exactly once, whether or not it was passed to
    /// Electron's `importSharedTexture` (which duplicates its own copy), to
    /// avoid leaking a kernel handle.
    pub fn receive_shared_texture(&self) -> Result<Option<SharedTextureHandleInfo>, String> {
        let handle = match self.handle {
            Some(h) => h,
            None => return Ok(None),
        };

        let mut nt_handle: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut width: u32 = 0;
        let mut height: u32 = 0;
        let mut format: u32 = 0;

        let ret = unsafe {
            ffi::spout_receiver_receive_shared_texture(
                handle,
                &mut nt_handle,
                &mut width,
                &mut height,
                &mut format,
            )
        };

        // Return codes mirror receive_rgba:
        //  0 = frame received (nt_handle populated)
        //  1 = no new frame
        //  2 = dimensions changed, poll again
        // -1 = not connected (sender disconnected or never appeared)
        // -2 = GPU op failed
        match ret {
            0 => {
                if nt_handle.is_null() {
                    return Err(
                        "Spout returned success but shared NT handle is null".into(),
                    );
                }
                Ok(Some(SharedTextureHandleInfo {
                    nt_handle: nt_handle as u64,
                    width,
                    height,
                    format,
                }))
            }
            1 | 2 => Ok(None),
            -1 => Err(
                "Shared texture receiver is not connected (sender disconnected or never appeared)"
                    .into(),
            ),
            -2 => Err("Spout shared-texture GPU operation failed".into()),
            _ => Ok(None),
        }
    }

    pub fn is_connected(&self) -> bool {
        match self.handle {
            Some(h) => unsafe { ffi::spout_receiver_is_connected(h) != 0 },
            None => false,
        }
    }

    pub fn width(&self) -> u32 {
        match self.handle {
            Some(h) => unsafe { ffi::spout_receiver_get_width(h) },
            None => 0,
        }
    }

    pub fn height(&self) -> u32 {
        match self.handle {
            Some(h) => unsafe { ffi::spout_receiver_get_height(h) },
            None => 0,
        }
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        self.destroy();
    }
}

/// List available Spout senders.
pub fn list_senders_json() -> Result<String, String> {
    unsafe {
        let ptr = ffi::spout_discovery_list_senders();
        if ptr.is_null() {
            return Err("Failed to list Spout senders".into());
        }
        // Always free the C string, even if UTF-8 conversion fails
        let result = std::ffi::CStr::from_ptr(ptr)
            .to_str()
            .map(|s| s.to_string())
            .map_err(|e| e.to_string());
        ffi::spout_discovery_free_string(ptr);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- spout_ring_pick_slot: pure slot picker for the push staging ring.
    // A slot is free when the last NT handle handed out for it no longer
    // refers to its texture (held == 0) and no staging copy is writing it
    // (gpu_busy == 0). Mirrors the macOS syphon_ring_pick_slot cases.

    fn pick_slot(held: &[u8], busy: &[u8]) -> i32 {
        assert_eq!(held.len(), busy.len());
        unsafe { ffi::spout_ring_pick_slot(held.as_ptr(), busy.as_ptr(), held.len() as u32) }
    }

    #[test]
    fn ring_pick_slot_returns_first_free_slot() {
        assert_eq!(pick_slot(&[1, 0, 0], &[0, 0, 0]), 1);
    }

    #[test]
    fn ring_pick_slot_skips_gpu_busy_slot() {
        assert_eq!(pick_slot(&[0, 0, 0], &[1, 0, 0]), 1);
    }

    #[test]
    fn ring_pick_slot_returns_minus_one_when_all_held() {
        assert_eq!(pick_slot(&[1, 1, 1], &[0, 0, 0]), -1);
    }

    #[test]
    fn ring_pick_slot_empty_ring() {
        assert_eq!(pick_slot(&[], &[]), -1);
    }
}
