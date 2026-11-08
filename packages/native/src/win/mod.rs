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

    /// A B8G8R8A8 texture shared through an NT handle, standing in for
    /// Electron's paint texture. Keeps the device, texture and handle alive
    /// until dropped.
    struct SharedSourceTexture {
        handle: windows::Win32::Foundation::HANDLE,
        _texture: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D,
        _context: windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
        _device: windows::Win32::Graphics::Direct3D11::ID3D11Device,
    }

    impl SharedSourceTexture {
        /// `pixels` is `width x height` tightly packed B, G, R, A bytes.
        fn bgra(pixels: &[u8], width: u32, height: u32) -> Self {
            use windows::core::Interface;
            use windows::Win32::Foundation::HMODULE;
            use windows::Win32::Graphics::Direct3D::{
                D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
            };
            use windows::Win32::Graphics::Direct3D11::{
                D3D11CreateDevice, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_RESOURCE_MISC_SHARED,
                D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_SDK_VERSION, D3D11_SUBRESOURCE_DATA,
                D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
            };
            use windows::Win32::Graphics::Dxgi::Common::{
                DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC,
            };
            use windows::Win32::Graphics::Dxgi::{
                IDXGIResource1, DXGI_SHARED_RESOURCE_READ, DXGI_SHARED_RESOURCE_WRITE,
            };

            assert_eq!(pixels.len(), (width * height * 4) as usize);
            let mut device = None;
            let mut context = None;
            unsafe {
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    Some(&[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0]),
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )
            }
            .unwrap_or_else(|e| panic!("D3D11CreateDevice for the test texture failed: {e}"));
            let device = device.expect("D3D11CreateDevice returned no device");
            let context = context.expect("D3D11CreateDevice returned no immediate context");

            let desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED.0)
                    as u32,
            };
            let initial = D3D11_SUBRESOURCE_DATA {
                pSysMem: pixels.as_ptr().cast(),
                SysMemPitch: width * 4,
                SysMemSlicePitch: 0,
            };
            let mut texture = None;
            unsafe { device.CreateTexture2D(&desc, Some(&initial), Some(&mut texture)) }
                .unwrap_or_else(|e| panic!("CreateTexture2D for the test texture failed: {e}"));
            let texture = texture.expect("CreateTexture2D returned no texture");
            // The Spout sender reads this texture on its own device; make sure
            // the initial-data upload has been submitted before it does.
            unsafe { context.Flush() };

            let handle = unsafe {
                texture.cast::<IDXGIResource1>().and_then(|resource| {
                    resource.CreateSharedHandle(
                        None,
                        DXGI_SHARED_RESOURCE_READ.0 | DXGI_SHARED_RESOURCE_WRITE.0,
                        windows::core::PCWSTR::null(),
                    )
                })
            }
            .unwrap_or_else(|e| panic!("CreateSharedHandle for the test texture failed: {e}"));

            Self {
                handle,
                _texture: texture,
                _context: context,
                _device: device,
            }
        }

        fn raw_handle(&self) -> RawTextureHandle {
            self.handle.0 as RawTextureHandle
        }
    }

    impl Drop for SharedSourceTexture {
        fn drop(&mut self) {
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.handle) };
        }
    }

    /// Fill a `width x height` frame whose left half is `left` and right half
    /// is `right`, each given as the 4 bytes of one pixel.
    fn split_frame(width: u32, height: u32, left: [u8; 4], right: [u8; 4]) -> Vec<u8> {
        (0..height)
            .flat_map(|_| (0..width).map(move |x| if x < width / 2 { left } else { right }))
            .flatten()
            .collect()
    }

    fn rgba_at(frame: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * width + x) * 4) as usize;
        [frame[i], frame[i + 1], frame[i + 2], frame[i + 3]]
    }

    // `receiveFrame()` is documented as tightly packed RGBA. A frame sent
    // through Spout in-process must come back with R, G and B in place, and
    // with left and right not swapped. Rows are not checked: every row is the
    // same.
    //
    // `Sender::send_rgba` is not implemented on Windows, so the frame goes in
    // the way Electron's paint texture does: a shared B8G8R8A8 texture passed
    // to `Sender::send` as an NT handle.
    #[test]
    fn receive_rgba_returns_rgba_byte_order() {
        use std::time::{Duration, Instant};

        const WIDTH: u32 = 64;
        const HEIGHT: u32 = 32;
        // The source texture is DXGI_FORMAT_B8G8R8A8_UNORM (what Electron's
        // compositor produces), and SpoutDX creates the sender in the source
        // texture's format, so the bytes are B, G, R, A. Logical colours:
        // left  R=200 G=100 B=50  A=255
        // right R=10  G=150 B=240 A=255
        let left_bgra = [50, 100, 200, 255];
        let right_bgra = [240, 150, 10, 255];
        let frame = split_frame(WIDTH, HEIGHT, left_bgra, right_bgra);
        let source = SharedSourceTexture::bgra(&frame, WIDTH, HEIGHT);

        let name = "etb-receive-rgba-order-test";
        let sender = Sender::new(name, WIDTH, HEIGHT).expect("create Spout sender");
        let mut receiver = receiver::Receiver::new(name).expect("create Spout receiver");

        // Resend every poll so the result does not depend on whether Spout's
        // frame counter counts frames sent before the receiver first looked.
        // receive_rgba returns Ok(None) for "no new frame" and for "staging
        // (re)allocated", and Err while the sender is not yet in Spout's
        // sender map.
        let deadline = Instant::now() + Duration::from_secs(5);
        let (pixels, width, height) = loop {
            sender.send(source.raw_handle()).expect("send shared texture via Spout");
            match receiver.receive_rgba() {
                Ok(Some(received)) => break received,
                Ok(None) | Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                Ok(None) => panic!("no frame received from {name} within 5 s"),
                Err(e) => panic!("Spout receiver never connected to {name}: {e}"),
            }
        };

        assert_eq!((width, height), (WIDTH, HEIGHT));
        assert_eq!(pixels.len(), (WIDTH * HEIGHT * 4) as usize);
        let y = HEIGHT / 2;
        assert_eq!(
            rgba_at(&pixels, width, 8, y),
            [200, 100, 50, 255],
            "left half must be RGBA"
        );
        assert_eq!(
            rgba_at(&pixels, width, WIDTH - 8, y),
            [10, 150, 240, 255],
            "right half must be RGBA"
        );
    }

    // The sender preview tap is documented as tightly packed RGBA, like
    // `receiveFrame()`. A B8G8R8A8 frame sent with the tap set must reach the
    // callback with R and B in place. The preview is a mip level, so columns
    // near the left/right boundary are blended; sample well inside each half.
    #[test]
    fn preview_tap_returns_rgba_byte_order() {
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};

        const WIDTH: u32 = 64;
        const HEIGHT: u32 = 32;
        // Same logical colours as receive_rgba_returns_rgba_byte_order.
        let left_bgra = [50, 100, 200, 255];
        let right_bgra = [240, 150, 10, 255];
        let frame = split_frame(WIDTH, HEIGHT, left_bgra, right_bgra);
        let source = SharedSourceTexture::bgra(&frame, WIDTH, HEIGHT);

        let mut sender =
            Sender::new("etb-preview-rgba-order-test", WIDTH, HEIGHT).expect("create Spout sender");
        let latest: Arc<Mutex<Option<(Vec<u8>, u32, u32)>>> = Arc::new(Mutex::new(None));
        let sink = Arc::clone(&latest);
        sender
            .set_preview(
                WIDTH / 2,
                HEIGHT / 2,
                Some(Box::new(move |rgba, width, height| {
                    *sink.lock().unwrap() = Some((rgba.to_vec(), width, height));
                })),
            )
            .expect("set preview tap");

        // The readback is asynchronous (staging ring, Map DO_NOT_WAIT), so
        // keep sending and polling until the callback has fired.
        let deadline = Instant::now() + Duration::from_secs(5);
        let (pixels, width, height) = loop {
            sender.send(source.raw_handle()).expect("send shared texture via Spout");
            sender.poll_preview();
            if let Some(preview) = latest.lock().unwrap().take() {
                break preview;
            }
            assert!(Instant::now() < deadline, "no preview delivered within 5 s");
            std::thread::sleep(Duration::from_millis(20));
        };

        assert_eq!((width, height), (WIDTH / 2, HEIGHT / 2));
        assert_eq!(pixels.len(), (width * height * 4) as usize);
        let y = height / 2;
        assert_eq!(
            rgba_at(&pixels, width, 2, y),
            [200, 100, 50, 255],
            "left half must be RGBA"
        );
        assert_eq!(
            rgba_at(&pixels, width, width - 3, y),
            [10, 150, 240, 255],
            "right half must be RGBA"
        );
    }
}
