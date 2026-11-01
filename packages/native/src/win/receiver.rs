use super::ffi;
use std::ffi::CString;

pub struct Receiver {
    handle: Option<ffi::SpoutReceiverHandle>,
    buffer: Vec<u8>,
    #[allow(dead_code)]
    sender_name: String,
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
        })
    }

    #[allow(dead_code)]
    pub fn sender_name(&self) -> &str {
        &self.sender_name
    }

    pub fn destroy(&mut self) {
        if let Some(h) = self.handle.take() {
            unsafe {
                ffi::spout_receiver_destroy(h);
            }
        }
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
