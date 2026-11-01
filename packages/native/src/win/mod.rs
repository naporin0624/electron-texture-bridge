mod ffi;
pub mod receiver;

use crate::types::RawTextureHandle;
use std::ffi::CString;

pub struct Sender {
    handle: ffi::SpoutBridgeHandle,
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
        Ok(Self { handle })
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
