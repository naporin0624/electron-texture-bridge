use super::ffi;
use std::ffi::CString;

pub struct Receiver {
    handle: ffi::SyphonReceiverHandle,
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

        Ok(Self { handle })
    }

    pub fn has_new_frame(&self) -> bool {
        unsafe { ffi::syphon_receiver_has_new_frame(self.handle) != 0 }
    }

    pub fn receive_rgba(&self) -> Result<Option<(Vec<u8>, u32, u32)>, String> {
        let mut width: u32 = 0;
        let mut height: u32 = 0;

        // First call with a small buffer to get dimensions
        // (or succeed if texture fits)
        let estimated_size = self.width() as usize * self.height() as usize * 4;
        let buf_size = if estimated_size > 0 { estimated_size } else { 4096 * 4096 * 4 };
        let mut buffer: Vec<u8> = vec![0u8; buf_size];

        let ret = unsafe {
            ffi::syphon_receiver_receive_rgba(
                self.handle,
                buffer.as_mut_ptr(),
                buf_size as u32,
                &mut width,
                &mut height,
            )
        };

        if ret != 0 {
            if width > 0 && height > 0 {
                // Buffer was too small; retry with correct size
                let correct_size = (width as usize) * (height as usize) * 4;
                buffer.resize(correct_size, 0);
                let ret2 = unsafe {
                    ffi::syphon_receiver_receive_rgba(
                        self.handle,
                        buffer.as_mut_ptr(),
                        correct_size as u32,
                        &mut width,
                        &mut height,
                    )
                };
                if ret2 != 0 {
                    return Ok(None);
                }
            } else {
                return Ok(None);
            }
        }

        let actual_size = (width as usize) * (height as usize) * 4;
        buffer.truncate(actual_size);
        Ok(Some((buffer, width, height)))
    }

    pub fn is_valid(&self) -> bool {
        unsafe { ffi::syphon_receiver_is_valid(self.handle) != 0 }
    }

    pub fn width(&self) -> u32 {
        unsafe { ffi::syphon_receiver_get_width(self.handle) }
    }

    pub fn height(&self) -> u32 {
        unsafe { ffi::syphon_receiver_get_height(self.handle) }
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        unsafe {
            ffi::syphon_receiver_destroy(self.handle);
        }
    }
}

/// List available Syphon servers as a JSON string.
pub fn list_servers_json() -> Result<String, String> {
    unsafe {
        let ptr = ffi::syphon_discovery_list_servers();
        if ptr.is_null() {
            return Err("Failed to list Syphon servers".into());
        }
        let json = std::ffi::CStr::from_ptr(ptr)
            .to_str()
            .map_err(|e| e.to_string())?
            .to_string();
        ffi::syphon_discovery_free_string(ptr);
        Ok(json)
    }
}
