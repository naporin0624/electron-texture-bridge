use super::ffi;
use std::ffi::CString;

pub struct Receiver {
    handle: ffi::SpoutReceiverHandle,
}

unsafe impl Send for Receiver {}

impl Receiver {
    pub fn new(sender_name: &str) -> Result<Self, String> {
        let c_name = CString::new(sender_name).map_err(|e| e.to_string())?;
        let handle = unsafe { ffi::spout_receiver_create(c_name.as_ptr()) };
        if handle.is_null() {
            return Err("Failed to create Spout receiver".into());
        }
        Ok(Self { handle })
    }

    pub fn has_new_frame(&self) -> bool {
        unsafe { ffi::spout_receiver_has_new_frame(self.handle) != 0 }
    }

    pub fn receive_rgba(&self) -> Result<Option<(Vec<u8>, u32, u32)>, String> {
        let mut width: u32 = 0;
        let mut height: u32 = 0;

        let estimated_size = self.width() as usize * self.height() as usize * 4;
        let buf_size = if estimated_size > 0 { estimated_size } else { 4096 * 4096 * 4 };
        let mut buffer: Vec<u8> = vec![0u8; buf_size];

        let ret = unsafe {
            ffi::spout_receiver_receive_rgba(
                self.handle,
                buffer.as_mut_ptr(),
                buf_size as u32,
                &mut width,
                &mut height,
            )
        };

        if ret != 0 {
            return Ok(None);
        }

        let actual_size = (width as usize) * (height as usize) * 4;
        buffer.truncate(actual_size);
        Ok(Some((buffer, width, height)))
    }

    pub fn is_connected(&self) -> bool {
        unsafe { ffi::spout_receiver_is_connected(self.handle) != 0 }
    }

    pub fn width(&self) -> u32 {
        unsafe { ffi::spout_receiver_get_width(self.handle) }
    }

    pub fn height(&self) -> u32 {
        unsafe { ffi::spout_receiver_get_height(self.handle) }
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        unsafe {
            ffi::spout_receiver_destroy(self.handle);
        }
    }
}

/// List available Spout senders.
pub fn list_senders_json() -> Result<String, String> {
    unsafe {
        let count = ffi::spout_discovery_get_sender_count();
        let mut senders = Vec::new();

        for i in 0..count {
            let mut name_buf = vec![0u8; 256];
            let ret = ffi::spout_discovery_get_sender_name(
                i,
                name_buf.as_mut_ptr() as *mut std::os::raw::c_char,
                256,
            );
            if ret == 0 {
                let name = std::ffi::CStr::from_ptr(name_buf.as_ptr() as *const std::os::raw::c_char)
                    .to_str()
                    .unwrap_or("")
                    .to_string();
                senders.push(format!(r#"{{"name":"{}"}}"#, name));
            }
        }

        Ok(format!("[{}]", senders.join(",")))
    }
}
