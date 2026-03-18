use super::ffi;
use std::ffi::CString;

pub struct Receiver {
    handle: Option<ffi::SyphonReceiverHandle>,
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

        Ok(Self { handle: Some(handle) })
    }

    pub fn destroy(&mut self) {
        if let Some(h) = self.handle.take() {
            unsafe { ffi::syphon_receiver_destroy(h); }
        }
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

        let estimated_size = self.width() as usize * self.height() as usize * 4;

        if estimated_size == 0 {
            // First call: probe for dimensions with a minimal buffer.
            // The C API sets out_width/out_height even on buffer-too-small (-1).
            let mut probe = vec![0u8; 4];
            unsafe {
                ffi::syphon_receiver_receive_rgba(
                    handle,
                    probe.as_mut_ptr(),
                    4,
                    &mut width,
                    &mut height,
                );
            }
            if width == 0 || height == 0 {
                // No server connected yet
                return Ok(None);
            }
            // Fall through to allocate correct size below
        } else {
            // Have cached dimensions — allocate exact size
            let mut buffer: Vec<u8> = vec![0u8; estimated_size];
            let ret = unsafe {
                ffi::syphon_receiver_receive_rgba(
                    handle,
                    buffer.as_mut_ptr(),
                    estimated_size as u32,
                    &mut width,
                    &mut height,
                )
            };

            if ret == 0 {
                let actual_size = (width as usize) * (height as usize) * 4;
                buffer.truncate(actual_size);
                return Ok(Some((buffer, width, height)));
            }

            // Dimensions changed — width/height updated by C API
            if width == 0 || height == 0 {
                return Ok(None);
            }
            // Fall through to retry with new dimensions
        }

        // Allocate with actual dimensions and retry
        let correct_size = (width as usize) * (height as usize) * 4;
        let mut buffer = vec![0u8; correct_size];
        let ret = unsafe {
            ffi::syphon_receiver_receive_rgba(
                handle,
                buffer.as_mut_ptr(),
                correct_size as u32,
                &mut width,
                &mut height,
            )
        };
        if ret != 0 {
            return Err("Syphon receive failed: Metal readback error after buffer retry".into());
        }
        let actual_size = (width as usize) * (height as usize) * 4;
        buffer.truncate(actual_size);
        Ok(Some((buffer, width, height)))
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
