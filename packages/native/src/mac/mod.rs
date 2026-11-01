mod ffi;
pub mod receiver;

use crate::types::RawTextureHandle;
use std::ffi::CString;

pub struct Sender {
    handle: ffi::SyphonBridgeHandle,
}

unsafe impl Send for Sender {}

impl Sender {
    pub fn new(name: &str) -> Result<Self, String> {
        let c_name = CString::new(name).map_err(|e| e.to_string())?;
        let handle = unsafe { ffi::syphon_bridge_create(c_name.as_ptr()) };
        if handle.is_null() {
            return Err("Failed to create Syphon Metal server".into());
        }
        Ok(Self { handle })
    }

    /// texture_handle: IOSurfaceID (from Electron, passed as i64)
    pub fn send(
        &self,
        texture_handle: RawTextureHandle,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        let surface_id = texture_handle as u32;
        let ret = unsafe { ffi::syphon_bridge_send(self.handle, surface_id, width, height) };
        if ret != 0 {
            Err("Failed to send texture via Syphon".into())
        } else {
            Ok(())
        }
    }

    /// Send IOSurface via direct pointer (from Electron's shared texture handle)
    pub fn send_surface(&self, surface_ptr: u64, width: u32, height: u32) -> Result<(), String> {
        let surface = surface_ptr as ffi::IOSurfaceRef;
        let ret = unsafe { ffi::syphon_bridge_send_surface(self.handle, surface, width, height) };
        if ret != 0 {
            Err("Failed to send IOSurface via Syphon".into())
        } else {
            Ok(())
        }
    }

    /// Send raw RGBA buffer data (from VideoFrame.copyTo())
    pub fn send_rgba(
        &self,
        data: &[u8],
        width: u32,
        height: u32,
        bytes_per_row: u32,
    ) -> Result<(), String> {
        let ret = unsafe {
            ffi::syphon_bridge_send_rgba(self.handle, data.as_ptr(), width, height, bytes_per_row)
        };
        if ret != 0 {
            Err("Failed to send RGBA buffer via Syphon".into())
        } else {
            Ok(())
        }
    }
}

impl Drop for Sender {
    fn drop(&mut self) {
        unsafe {
            ffi::syphon_bridge_destroy(self.handle);
        }
    }
}

/// Release a raw `IOSurfaceRef` minted by the receiver — exactly once per
/// handle, whether or not it was passed to Electron's `importSharedTexture`
/// (which retains its own reference). Returns `Ok(())` on success, or an error
/// describing the failure (null pointer).
pub fn close_shared_iosurface(raw_ptr: u64) -> Result<(), String> {
    if raw_ptr == 0 {
        return Err("Cannot close null IOSurface pointer".into());
    }
    let ret = unsafe { ffi::native_close_shared_iosurface(raw_ptr as usize) };
    if ret != 0 {
        return Err("CFRelease failed for shared IOSurface".into());
    }
    Ok(())
}
