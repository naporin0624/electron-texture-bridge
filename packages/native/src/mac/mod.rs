mod ffi;
pub mod receiver;

use crate::types::{PreviewCallback, RawTextureHandle};
use std::ffi::CString;

pub struct Sender {
    handle: ffi::SyphonBridgeHandle,
    /// Boxed so its address (the C callback context) stays stable. Freed only
    /// after the C side guarantees the callback is no longer running: on
    /// replacement (the C setter swaps under the preview mutex) and after
    /// `syphon_bridge_destroy` in `Drop` (fields drop after `drop()` runs).
    preview_callback: Option<Box<PreviewCallback>>,
}

/// `extern "C"` trampoline handed to `syphon_bridge_set_preview`. `ctx` is the
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

unsafe impl Send for Sender {}

impl Sender {
    pub fn new(name: &str) -> Result<Self, String> {
        let c_name = CString::new(name).map_err(|e| e.to_string())?;
        let handle = unsafe { ffi::syphon_bridge_create(c_name.as_ptr()) };
        if handle.is_null() {
            return Err("Failed to create Syphon Metal server".into());
        }
        Ok(Self {
            handle,
            preview_callback: None,
        })
    }

    /// Enable (`Some`) or disable (`None`) the downscaled preview tap. The
    /// preview fits inside `max_width x max_height` (aspect preserved).
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
                ffi::syphon_bridge_set_preview(
                    self.handle,
                    max_width,
                    max_height,
                    Some(preview_callback_trampoline),
                    ctx,
                )
            },
            None => unsafe {
                ffi::syphon_bridge_set_preview(self.handle, 0, 0, None, std::ptr::null_mut())
            },
        };
        match ret {
            0 => {
                // The C setter swapped the callback under the mutex the
                // completion handler holds while invoking it: the previous
                // one is no longer running and can be freed.
                self.preview_callback = next;
                Ok(())
            }
            -2 => {
                // The tap was left disabled; the old callback is detached too.
                self.preview_callback = None;
                Err("Failed to build the Metal preview pipeline".into())
            }
            // Refused before touching the shared state: the previous
            // callback is still installed (and still owned here). Callers
            // that want it gone detach with `set_preview(0, 0, None)`.
            _ => Err("Invalid preview size".into()),
        }
    }

    /// No-op: Metal completion handlers deliver every preview on their own.
    /// Always `false` (nothing for the caller to poll).
    pub fn poll_preview(&self) -> bool {
        false
    }

    #[cfg(test)]
    fn texture_cache_count(&self) -> u32 {
        unsafe { ffi::syphon_bridge_texture_cache_count(self.handle) }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Little-endian BGRA packing used by `syphon_debug_create_split_iosurface`.
    const fn bgra(r: u32, g: u32, b: u32, a: u32) -> u32 {
        b | (g << 8) | (r << 16) | (a << 24)
    }

    struct TestSurface(ffi::IOSurfaceRef);

    impl TestSurface {
        fn split(width: u32, height: u32, top: u32, bottom: u32) -> Self {
            let ptr = unsafe { ffi::syphon_debug_create_split_iosurface(width, height, top, bottom) };
            assert!(!ptr.is_null(), "create test IOSurface");
            Self(ptr)
        }
        fn addr(&self) -> u64 {
            self.0 as u64
        }
    }

    impl Drop for TestSurface {
        fn drop(&mut self) {
            let _ = close_shared_iosurface(self.0 as u64);
        }
    }

    fn fit(src_w: u32, src_h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
        let (mut w, mut h) = (0u32, 0u32);
        unsafe { ffi::syphon_preview_fit_size(src_w, src_h, max_w, max_h, &mut w, &mut h) };
        (w, h)
    }

    #[test]
    fn preview_fit_size_keeps_aspect_and_never_upscales() {
        assert_eq!(fit(1920, 1080, 384, 216), (384, 216));
        assert_eq!(fit(1920, 1080, 384, 384), (384, 216)); // width-bound
        assert_eq!(fit(1080, 1920, 384, 216), (122, 216)); // portrait, height-bound
        assert_eq!(fit(320, 180, 384, 216), (320, 180)); // never upscaled
        assert_eq!(fit(4000, 1, 100, 100), (100, 1)); // never below 1
        assert_eq!(fit(0, 1080, 384, 216), (0, 0));
        assert_eq!(fit(1920, 1080, 0, 216), (0, 0));
    }

    #[test]
    fn preview_taps_cover_the_source_footprint() {
        assert_eq!(unsafe { ffi::syphon_preview_taps(1920, 384) }, 3); // 5x
        assert_eq!(unsafe { ffi::syphon_preview_taps(1920, 960) }, 1); // 2x
        assert_eq!(unsafe { ffi::syphon_preview_taps(384, 384) }, 1);
        assert_eq!(unsafe { ffi::syphon_preview_taps(100, 400) }, 1); // upscale
        assert_eq!(unsafe { ffi::syphon_preview_taps(7680, 100) }, 8); // clamped
        assert_eq!(unsafe { ffi::syphon_preview_taps(0, 0) }, 1);
    }

    type PreviewMsg = (Vec<u8>, u32, u32);

    fn preview_channel() -> (PreviewCallback, mpsc::Receiver<PreviewMsg>) {
        let (tx, rx) = mpsc::channel::<PreviewMsg>();
        let tx = std::sync::Mutex::new(tx);
        let cb: PreviewCallback = Box::new(move |bytes: &[u8], w: u32, h: u32| {
            let _ = tx.lock().unwrap().send((bytes.to_vec(), w, h));
        });
        (cb, rx)
    }

    fn pixel(frame: &PreviewMsg, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * frame.1 + x) * 4) as usize;
        [frame.0[i], frame.0[i + 1], frame.0[i + 2], frame.0[i + 3]]
    }

    // The one test that pins orientation + channel order without Electron:
    // a paint-like BGRA IOSurface (row 0 = top) with a red top half and a blue
    // bottom half must come back as upright RGBA bytes.
    #[test]
    fn preview_delivers_upright_rgba_bytes_fitted_to_the_bounds() {
        let mut sender = Sender::new("etb-preview-orientation-test").expect("create sender");
        let (cb, rx) = preview_channel();
        sender.set_preview(160, 160, Some(cb)).expect("enable preview");

        let surface = TestSurface::split(640, 360, bgra(255, 0, 0, 255), bgra(0, 0, 255, 255));
        sender.send_surface(surface.addr(), 640, 360).expect("send");

        let frame = rx.recv_timeout(Duration::from_secs(5)).expect("preview frame");
        assert_eq!((frame.1, frame.2), (160, 90));
        assert_eq!(frame.0.len(), 160 * 90 * 4);
        assert_eq!(pixel(&frame, 80, 5), [255, 0, 0, 255], "top row must be red");
        assert_eq!(pixel(&frame, 80, 84), [0, 0, 255, 255], "bottom row must be blue");
        assert_eq!(pixel(&frame, 0, 0), [255, 0, 0, 255]);
        assert_eq!(pixel(&frame, 159, 89), [0, 0, 255, 255]);
    }

    #[test]
    fn preview_follows_a_source_resize() {
        let mut sender = Sender::new("etb-preview-resize-test").expect("create sender");
        let (cb, rx) = preview_channel();
        sender.set_preview(384, 216, Some(cb)).expect("enable preview");

        let landscape = TestSurface::split(1920, 1080, bgra(0, 255, 0, 255), bgra(0, 255, 0, 255));
        sender.send_surface(landscape.addr(), 1920, 1080).expect("send");
        let first = rx.recv_timeout(Duration::from_secs(5)).expect("first preview");
        assert_eq!((first.1, first.2), (384, 216));
        assert_eq!(pixel(&first, 10, 10), [0, 255, 0, 255]);

        let portrait = TestSurface::split(1080, 1920, bgra(255, 255, 255, 255), bgra(0, 0, 0, 255));
        sender.send_surface(portrait.addr(), 1080, 1920).expect("send");
        let second = rx.recv_timeout(Duration::from_secs(5)).expect("second preview");
        assert_eq!((second.1, second.2), (122, 216));
        assert_eq!(pixel(&second, 60, 2), [255, 255, 255, 255]);
        assert_eq!(pixel(&second, 60, 213), [0, 0, 0, 255]);
    }

    #[test]
    fn disabled_preview_never_calls_back() {
        let mut sender = Sender::new("etb-preview-disable-test").expect("create sender");
        let (cb, rx) = preview_channel();
        sender.set_preview(64, 64, Some(cb)).expect("enable preview");
        sender.set_preview(0, 0, None).expect("disable preview");

        let surface = TestSurface::split(128, 128, bgra(1, 2, 3, 255), bgra(1, 2, 3, 255));
        for _ in 0..5 {
            sender.send_surface(surface.addr(), 128, 128).expect("send");
        }
        drop(sender); // drains every in-flight publish
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn preview_rejects_a_zero_bound() {
        let mut sender = Sender::new("etb-preview-zero-test").expect("create sender");
        let (cb, _rx) = preview_channel();
        assert!(sender.set_preview(0, 216, Some(cb)).is_err());
    }

    // Dropping the sender (destroy) while preview deliveries are in flight
    // must not call into the freed callback (a crash would fail the binary).
    #[test]
    fn sender_drop_with_preview_in_flight_does_not_crash() {
        let surface = TestSurface::split(1280, 720, bgra(9, 9, 9, 255), bgra(9, 9, 9, 255));
        for i in 0..100 {
            let mut sender =
                Sender::new(&format!("etb-preview-drop-test-{i}")).expect("create sender");
            let (cb, _rx) = preview_channel();
            sender.set_preview(320, 180, Some(cb)).expect("enable preview");
            for _ in 0..3 {
                sender.send_surface(surface.addr(), 1280, 720).expect("send");
            }
            drop(sender);
        }
    }

    // Swapping the callback while publishes are in flight: once set_preview(b)
    // returns, `a` (freed right then) is never called again; the frames still
    // in flight go to `b` (deliver_preview reads the current callback), and
    // dropping the sender drains the rest without calling into a freed box.
    #[test]
    fn preview_callback_swap_with_publishes_in_flight() {
        let surface = TestSurface::split(1280, 720, bgra(7, 7, 7, 255), bgra(7, 7, 7, 255));
        let mut b_frames = 0usize;
        for i in 0..100 {
            let mut sender =
                Sender::new(&format!("etb-preview-swap-test-{i}")).expect("create sender");
            let (cb_a, rx_a) = preview_channel();
            let (cb_b, rx_b) = preview_channel();
            sender.set_preview(320, 180, Some(cb_a)).expect("enable preview a");
            for _ in 0..3 {
                sender.send_surface(surface.addr(), 1280, 720).expect("send");
            }
            sender.set_preview(320, 180, Some(cb_b)).expect("swap to preview b");
            // Everything `a` will ever get has arrived by now.
            let a_before = rx_a.try_iter().count();
            for _ in 0..3 {
                sender.send_surface(surface.addr(), 1280, 720).expect("send");
            }
            drop(sender); // drains every in-flight publish
            assert_eq!(
                rx_a.try_iter().count(),
                0,
                "callback a was invoked after it was replaced (had {a_before} before)"
            );
            b_frames += rx_b.try_iter().count();
        }
        assert!(b_frames > 0, "the replacement callback must receive frames");
    }

    // lib.rs's failure path: a refused replacement leaves the old callback
    // installed, and the follow-up detach must silence it.
    #[test]
    fn refused_replacement_then_detach_silences_the_old_callback() {
        let mut sender = Sender::new("etb-preview-refused-test").expect("create sender");
        let (cb_a, rx_a) = preview_channel();
        let (cb_b, _rx_b) = preview_channel();
        sender.set_preview(64, 64, Some(cb_a)).expect("enable preview a");
        assert!(sender.set_preview(0, 64, Some(cb_b)).is_err());
        sender.set_preview(0, 0, None).expect("detach");

        let surface = TestSurface::split(128, 128, bgra(1, 2, 3, 255), bgra(1, 2, 3, 255));
        for _ in 0..3 {
            sender.send_surface(surface.addr(), 128, 128).expect("send");
        }
        drop(sender);
        assert!(rx_a.try_recv().is_err());
    }

    #[test]
    fn poll_preview_is_a_no_op_on_macos() {
        let mut sender = Sender::new("etb-preview-poll-test").expect("create sender");
        assert!(!sender.poll_preview());
        let (cb, _rx) = preview_channel();
        sender.set_preview(64, 64, Some(cb)).expect("enable preview");
        let surface = TestSurface::split(128, 128, bgra(1, 2, 3, 255), bgra(1, 2, 3, 255));
        sender.send_surface(surface.addr(), 128, 128).expect("send");
        assert!(!sender.poll_preview());
    }

    #[test]
    fn texture_cache_reuses_wrappers_per_surface_and_drops_them_on_resize() {
        let sender = Sender::new("etb-texture-cache-test").expect("create sender");
        let a = TestSurface::split(256, 128, bgra(1, 1, 1, 255), bgra(1, 1, 1, 255));
        let b = TestSurface::split(256, 128, bgra(2, 2, 2, 255), bgra(2, 2, 2, 255));

        for _ in 0..5 {
            sender.send_surface(a.addr(), 256, 128).expect("send a");
        }
        assert_eq!(sender.texture_cache_count(), 1, "same surface reuses one wrapper");

        sender.send_surface(b.addr(), 256, 128).expect("send b");
        sender.send_surface(a.addr(), 256, 128).expect("send a again");
        assert_eq!(sender.texture_cache_count(), 2);

        let resized = TestSurface::split(512, 256, bgra(3, 3, 3, 255), bgra(3, 3, 3, 255));
        sender.send_surface(resized.addr(), 512, 256).expect("send resized");
        assert_eq!(sender.texture_cache_count(), 1, "a resize retires the old pool");
    }

    // A capturer pool that is abandoned (renderer reload / crash) must not
    // stay retained by the cache until the next resize.
    #[test]
    fn texture_cache_drops_wrappers_of_an_abandoned_pool() {
        let sender = Sender::new("etb-texture-cache-idle-test").expect("create sender");
        let make_pool = |seed: u32| -> Vec<TestSurface> {
            (0..8)
                .map(|i| TestSurface::split(64, 64, bgra(seed, i, 0, 255), bgra(seed, i, 0, 255)))
                .collect()
        };
        let old_pool = make_pool(1);
        for s in &old_pool {
            sender.send_surface(s.addr(), 64, 64).expect("send old");
        }
        assert_eq!(sender.texture_cache_count(), 8);

        let new_pool = make_pool(2);
        for _ in 0..20 {
            for s in &new_pool {
                sender.send_surface(s.addr(), 64, 64).expect("send new");
            }
        }
        assert_eq!(sender.texture_cache_count(), 8, "only the live pool stays cached");
    }

    #[test]
    fn texture_cache_is_bounded() {
        let sender = Sender::new("etb-texture-cache-bound-test").expect("create sender");
        let surfaces: Vec<TestSurface> = (0..24)
            .map(|i| TestSurface::split(64, 64, bgra(i, i, i, 255), bgra(i, i, i, 255)))
            .collect();
        for s in &surfaces {
            sender.send_surface(s.addr(), 64, 64).expect("send");
        }
        assert_eq!(sender.texture_cache_count(), 16);
    }

    // Regression: `Sender::drop` used to call `-[SyphonMetalServer stop]` while
    // Syphon's own completed handler for a just-committed publish was still
    // running `-[SyphonServerConnectionManager publishNewFrame]` on a Metal
    // completion thread. Stopping released the connection manager's dispatch
    // queue under that `dispatch_sync`, crashing the process with SIGSEGV
    // (completion thread) or SIGTRAP "Premature release of a locked queue"
    // (stopping thread). A crash of the test binary is the failure signal.
    //
    // 720p rather than 4K on purpose: the small blit finishes on the GPU
    // within the few hundred microseconds between commit and drop, so
    // Syphon's handler is reliably mid-publish when `stop` runs (crashed
    // every run pre-fix; 4K at 300 iterations only crashed ~1 run in 5).
    #[test]
    fn sender_drop_right_after_publish_does_not_crash() {
        const WIDTH: u32 = 1280;
        const HEIGHT: u32 = 720;
        const ITERATIONS: usize = 500;
        const SENDS_PER_SENDER: usize = 3;

        let bytes_per_row = WIDTH * 4;
        let frame = vec![0x7fu8; (bytes_per_row * HEIGHT) as usize];

        for i in 0..ITERATIONS {
            let sender =
                Sender::new(&format!("etb-stop-race-test-{i}")).expect("create Syphon sender");
            for _ in 0..SENDS_PER_SENDER {
                sender
                    .send_rgba(&frame, WIDTH, HEIGHT, bytes_per_row)
                    .expect("publish RGBA frame");
            }
            drop(sender);
        }
    }
}
