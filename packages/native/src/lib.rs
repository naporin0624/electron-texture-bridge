mod types;

#[cfg(target_os = "windows")]
mod win;
#[cfg(target_os = "macos")]
mod mac;

use napi::*;
use napi_derive::napi;

// ============================================================
// JS API: TextureSender
//
//   const sender = new TextureSender("MyVJ", 1920, 1080)
//   sender.send(handle, width, height)
//   sender.stop()
//
// ============================================================

#[napi]
pub struct TextureSender {
    #[cfg(target_os = "windows")]
    inner: Option<win::Sender>,
    #[cfg(target_os = "macos")]
    inner: Option<mac::Sender>,

    width: u32,
    height: u32,
}

#[napi]
impl TextureSender {
    /// Create a new texture sender.
    ///
    /// - `name`: Sender name visible in Spout/Syphon receivers
    /// - `width`: Initial texture width
    /// - `height`: Initial texture height
    #[napi(constructor)]
    pub fn new(name: String, width: u32, height: u32) -> Result<Self> {
        #[cfg(target_os = "windows")]
        let inner = win::Sender::new(&name, width, height)
            .map_err(|e| Error::from_reason(e))?;

        #[cfg(target_os = "macos")]
        let inner = mac::Sender::new(&name)
            .map_err(|e| Error::from_reason(e))?;

        Ok(Self { inner: Some(inner), width, height })
    }

    /// Send a shared texture to Spout (Win) or Syphon (Mac).
    ///
    /// - `handle`: The native texture handle from Electron's paint event
    ///   - Windows: `texture.textureInfo.handle` (DXGI HANDLE as number/BigInt)
    ///   - macOS: `texture.textureInfo.handle` (IOSurfaceID as number)
    /// - `width`: Texture width (from `textureInfo.codedSize.width`)
    /// - `height`: Texture height (from `textureInfo.codedSize.height`)
    #[napi]
    pub fn send(&mut self, handle: i64, width: u32, height: u32) -> Result<()> {
        let inner = self.inner.as_mut()
            .ok_or_else(|| Error::from_reason("TextureSender has been stopped"))?;
        self.width = width;
        self.height = height;

        #[cfg(target_os = "windows")]
        {
            inner.send(handle)
                .map_err(|e| Error::from_reason(e))?;
        }

        #[cfg(target_os = "macos")]
        {
            inner.send(handle, width, height)
                .map_err(|e| Error::from_reason(e))?;
        }

        Ok(())
    }

    /// Send an IOSurface by direct pointer (macOS only).
    /// Use this when you have an IOSurfaceRef buffer from Electron's shared texture.
    ///
    /// - `surface_buffer`: Buffer containing IOSurfaceRef pointer (8 bytes on 64-bit)
    /// - `width`: Texture width
    /// - `height`: Texture height
    #[napi]
    pub fn send_surface(
        &mut self,
        surface_buffer: napi::bindgen_prelude::Buffer,
        width: u32,
        height: u32,
    ) -> Result<()> {
        let inner = self.inner.as_mut()
            .ok_or_else(|| Error::from_reason("TextureSender has been stopped"))?;
        self.width = width;
        self.height = height;

        #[cfg(target_os = "macos")]
        {
            // Extract pointer from buffer (8 bytes = u64 pointer on 64-bit)
            if surface_buffer.len() < 8 {
                return Err(Error::from_reason("Surface buffer too small"));
            }
            let ptr_bytes: [u8; 8] = surface_buffer[..8].try_into()
                .map_err(|_| Error::from_reason("Failed to read surface pointer"))?;
            let surface_ptr = u64::from_le_bytes(ptr_bytes);

            inner.send_surface(surface_ptr, width, height)
                .map_err(|e| Error::from_reason(e))?;
        }

        #[cfg(target_os = "windows")]
        {
            let _ = inner;
            return Err(Error::from_reason("send_surface is macOS only"));
        }

        Ok(())
    }

    /// Stop the sender and release native resources immediately.
    /// This is a terminal operation — the sender cannot be reused afterward.
    /// Repeated calls are safe and idempotent.
    #[napi]
    pub fn stop(&mut self) -> Result<()> {
        // Drop the inner sender immediately, releasing native resources.
        // Subsequent calls are idempotent (inner is already None).
        self.inner.take();
        Ok(())
    }

    /// Send raw RGBA buffer data to Syphon/Spout.
    /// Use this for VideoFrame.copyTo() workflow where you have pixel data in a Buffer.
    ///
    /// - `data`: Buffer containing RGBA pixel data (BGRA format expected)
    /// - `width`: Texture width in pixels
    /// - `height`: Texture height in pixels
    /// - `bytes_per_row`: Optional stride in bytes. Defaults to width * 4 if not provided.
    #[napi]
    pub fn send_rgba_buffer(
        &mut self,
        data: napi::bindgen_prelude::Buffer,
        width: u32,
        height: u32,
        bytes_per_row: Option<u32>,
    ) -> Result<()> {
        let inner = self.inner.as_mut()
            .ok_or_else(|| Error::from_reason("TextureSender has been stopped"))?;
        let stride = bytes_per_row.unwrap_or(width * 4);

        self.width = width;
        self.height = height;

        inner
            .send_rgba(data.as_ref(), width, height, stride)
            .map_err(|e| Error::from_reason(e))
    }

    /// Returns true if native resources have been released via `stop()`.
    #[cfg(test)]
    pub fn is_stopped(&self) -> bool {
        self.inner.is_none()
    }

    /// Get the current platform name.
    #[napi]
    pub fn platform(&self) -> String {
        #[cfg(target_os = "windows")]
        return "spout".to_string();
        #[cfg(target_os = "macos")]
        return "syphon-metal".to_string();
    }
}

/// Returns the current platform's texture sharing protocol name.
#[napi]
pub fn get_platform() -> String {
    #[cfg(target_os = "windows")]
    return "spout".to_string();
    #[cfg(target_os = "macos")]
    return "syphon-metal".to_string();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return "unsupported".to_string();
}

// ============================================================
// Sender info for discovery
// ============================================================

/// Information about an available texture sender (Syphon server / Spout sender).
#[derive(Debug, Clone, PartialEq)]
pub struct SenderInfo {
    pub name: String,
    pub app_name: Option<String>,
    pub uuid: Option<String>,
}

/// Parse a JSON string from the C++ discovery bridge into a Vec<SenderInfo>.
fn parse_senders_json(json: &str) -> std::result::Result<Vec<SenderInfo>, String> {
    let array: Vec<serde_json::Value> =
        serde_json::from_str(json).map_err(|e| format!("Invalid JSON: {}", e))?;

    array
        .into_iter()
        .map(|v| {
            let name = v
                .get("name")
                .and_then(|n| n.as_str())
                .ok_or_else(|| "Missing 'name' field in sender info".to_string())?;
            let app_name = v.get("appName").and_then(|n| n.as_str()).map(String::from);
            let uuid = v.get("uuid").and_then(|n| n.as_str()).map(String::from);
            Ok(SenderInfo {
                name: name.to_string(),
                app_name,
                uuid,
            })
        })
        .collect()
}

// ============================================================
// JS API: TextureReceiver
//
//   const receiver = new TextureReceiver("ServerName")
//   if (receiver.hasNewFrame()) {
//     const frame = receiver.receiveFrame()
//     // frame: { data: Buffer, width: number, height: number }
//   }
//   receiver.stop()
//
// ============================================================

/// napi-rs object returned from receiveFrame()
#[napi(object)]
pub struct ReceivedFrame {
    pub data: napi::bindgen_prelude::Buffer,
    pub width: u32,
    pub height: u32,
}

/// napi-rs object returned from listSenders()
#[napi(object)]
pub struct JsSenderInfo {
    pub name: String,
    pub app_name: Option<String>,
    pub uuid: Option<String>,
}

#[napi]
pub struct TextureReceiver {
    #[cfg(target_os = "macos")]
    inner: Option<mac::receiver::Receiver>,
    #[cfg(target_os = "windows")]
    inner: Option<win::receiver::Receiver>,
}

#[napi]
impl TextureReceiver {
    /// Create a new texture receiver.
    ///
    /// - `sender_name`: Name of the Syphon server / Spout sender to connect to
    /// - `app_name`: (macOS only) Filter by application name
    /// - `server_uuid`: (macOS only) Connect by server UUID (highest priority)
    #[napi(constructor)]
    pub fn new(
        sender_name: String,
        app_name: Option<String>,
        server_uuid: Option<String>,
    ) -> Result<Self> {
        #[cfg(target_os = "macos")]
        let inner = mac::receiver::Receiver::new(
            server_uuid.as_deref(),
            Some(&sender_name),
            app_name.as_deref(),
        )
        .map_err(|e| Error::from_reason(e))?;

        #[cfg(target_os = "windows")]
        let inner = win::receiver::Receiver::new(&sender_name)
            .map_err(|e| Error::from_reason(e))?;

        Ok(Self { inner: Some(inner) })
    }

    /// Returns true if the server has output a new frame since the last receive.
    /// Returns false if `stop()` has been called.
    #[napi]
    pub fn has_new_frame(&self) -> bool {
        self.inner.as_ref().map_or(false, |r| r.has_new_frame())
    }

    /// Receive the current frame as RGBA pixel data.
    /// Returns null if no frame is available or if `stop()` has been called.
    #[napi]
    pub fn receive_frame(&self) -> Result<Option<ReceivedFrame>> {
        let inner = match &self.inner {
            Some(r) => r,
            None => return Ok(None),
        };
        match inner.receive_rgba() {
            Ok(Some((data, width, height))) => Ok(Some(ReceivedFrame {
                data: data.into(),
                width,
                height,
            })),
            Ok(None) => Ok(None),
            Err(e) => Err(Error::from_reason(e)),
        }
    }

    /// Returns true if the receiver has a valid connection to a server.
    /// Returns false if `stop()` has been called.
    #[napi]
    pub fn is_connected(&self) -> bool {
        match &self.inner {
            Some(r) => {
                #[cfg(target_os = "macos")]
                return r.is_valid();
                #[cfg(target_os = "windows")]
                return r.is_connected();
            }
            None => false,
        }
    }

    /// Get the width of the last received texture.
    /// Returns 0 if `stop()` has been called.
    #[napi]
    pub fn get_width(&self) -> u32 {
        self.inner.as_ref().map_or(0, |r| r.width())
    }

    /// Get the height of the last received texture.
    /// Returns 0 if `stop()` has been called.
    #[napi]
    pub fn get_height(&self) -> u32 {
        self.inner.as_ref().map_or(0, |r| r.height())
    }

    /// Stop the receiver and release native resources immediately.
    /// This is a terminal operation — the receiver cannot be reused afterward.
    /// Repeated calls are safe and idempotent.
    #[napi]
    pub fn stop(&mut self) -> Result<()> {
        if let Some(mut r) = self.inner.take() {
            r.destroy();
        }
        Ok(())
    }

    /// Returns true if native resources have been released via `stop()`.
    #[cfg(test)]
    pub fn is_stopped(&self) -> bool {
        self.inner.is_none()
    }

    /// Get the current platform name.
    #[napi]
    pub fn platform(&self) -> String {
        #[cfg(target_os = "windows")]
        return "spout".to_string();
        #[cfg(target_os = "macos")]
        return "syphon-metal".to_string();
    }
}

/// List all available texture senders (Syphon servers / Spout senders).
#[napi]
pub fn list_senders() -> Result<Vec<JsSenderInfo>> {
    #[cfg(target_os = "macos")]
    let json = mac::receiver::list_servers_json()
        .map_err(|e| Error::from_reason(e))?;

    #[cfg(target_os = "windows")]
    let json = win::receiver::list_senders_json()
        .map_err(|e| Error::from_reason(e))?;

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let json = "[]".to_string();

    let infos = parse_senders_json(&json)
        .map_err(|e| Error::from_reason(e))?;

    Ok(infos
        .into_iter()
        .map(|info| JsSenderInfo {
            name: info.name,
            app_name: info.app_name,
            uuid: info.uuid,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Disposal lifecycle tests ----
    //
    // Note: TextureSender and TextureReceiver types link platform-specific C++
    // bridge code (Syphon/Spout). Constructing instances in pure Rust tests
    // pulls in C++ runtime symbols that are unavailable in the test binary
    // linker context. The full lifecycle (stop → error on use, idempotent stop)
    // is tested at the integration level via TypeScript tests in the core and
    // renderer packages.
    //
    // The compile-time contract is enforced by the Option<Inner> pattern:
    // - `stop()` calls `self.inner.take()` → deterministic drop
    // - Operational methods call `self.inner.as_mut().ok_or_else(...)` → error after stop
    // - Read-only methods call `self.inner.as_ref().map_or(default, ...)` → safe defaults

    // ---- parse_senders_json tests ----

    #[test]
    fn parse_senders_json_valid_array() {
        let json = r#"[{"name":"VJ","appName":"Resolume","uuid":"abc-123"}]"#;
        let result = parse_senders_json(json).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "VJ");
        assert_eq!(result[0].app_name, Some("Resolume".to_string()));
        assert_eq!(result[0].uuid, Some("abc-123".to_string()));
    }

    #[test]
    fn parse_senders_json_multiple_senders() {
        let json = r#"[{"name":"A","appName":"App1","uuid":"1"},{"name":"B"}]"#;
        let result = parse_senders_json(json).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "A");
        assert_eq!(result[1].name, "B");
        assert_eq!(result[1].app_name, None);
        assert_eq!(result[1].uuid, None);
    }

    #[test]
    fn parse_senders_json_empty_array() {
        let json = "[]";
        let result = parse_senders_json(json).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn parse_senders_json_invalid_json() {
        let json = "not valid json";
        let result = parse_senders_json(json);
        assert!(result.is_err());
    }

    #[test]
    fn parse_senders_json_missing_name() {
        let json = r#"[{"appName":"App"}]"#;
        let result = parse_senders_json(json);
        assert!(result.is_err());
    }

    #[test]
    fn sender_info_to_js_sender_info_conversion() {
        let info = SenderInfo {
            name: "Test".to_string(),
            app_name: Some("App".to_string()),
            uuid: None,
        };
        let js_info = JsSenderInfo {
            name: info.name.clone(),
            app_name: info.app_name.clone(),
            uuid: info.uuid.clone(),
        };
        assert_eq!(js_info.name, "Test");
        assert_eq!(js_info.app_name, Some("App".to_string()));
        assert_eq!(js_info.uuid, None);
    }

    #[test]
    fn parse_senders_json_with_special_characters_in_name() {
        let json = r#"[{"name":"My \"VJ\" App"}]"#;
        let result = parse_senders_json(json).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, r#"My "VJ" App"#);
    }

    #[test]
    fn parse_senders_json_with_null_fields() {
        let json = r#"[{"name":"VJ","appName":null,"uuid":null}]"#;
        let result = parse_senders_json(json).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "VJ");
        assert_eq!(result[0].app_name, None);
        assert_eq!(result[0].uuid, None);
    }
}
