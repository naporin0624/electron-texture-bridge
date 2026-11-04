#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
mod preview_gate;
mod types;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "windows")]
mod win;

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

    /// JS side of the preview tap. Detached (and released) once the native
    /// side stopped invoking it (`set_preview` replace / `null`, `stop()`).
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    preview_tap: Option<PreviewTap>,
}

/// Downscaled preview frame delivered by `TextureSender.setPreview`.
///
/// `data` holds `width * height * 4` bytes of tightly packed RGBA, top row
/// first — directly usable as `new ImageData(new Uint8ClampedArray(data.buffer,
/// data.byteOffset, data.byteLength), width, height)`.
#[napi(object)]
pub struct PreviewFrame {
    pub data: napi::bindgen_prelude::Buffer,
    pub width: u32,
    pub height: u32,
}

/// Preview bytes in transit from the native thread to JS.
#[cfg(any(target_os = "macos", target_os = "windows"))]
struct PreviewPayload {
    data: Vec<u8>,
    width: u32,
    height: u32,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
type PreviewTsfn = napi::threadsafe_function::ThreadsafeFunction<
    PreviewPayload,
    napi::threadsafe_function::ErrorStrategy::Fatal,
>;

/// One installed preview callback: its ThreadsafeFunction plus the flag that
/// turns deliveries still queued for it into no-ops once it is detached.
///
/// Why not `abort`: an aborted TSFN never dispatches its queue; Node hands each
/// leftover item to `call_js_cb` with a null env (`EmptyQueueAndDelete`), and
/// napi-rs 2's `call_js_cb` returns early on a null env without freeing the
/// boxed payload — one whole preview buffer leaked per queued frame. Released
/// (not aborted) TSFNs dispatch every queued item normally, so each payload is
/// freed; `detached` makes the stale ones skip the user callback.
#[cfg(any(target_os = "macos", target_os = "windows"))]
struct PreviewTap {
    /// Held for its `Drop`, which releases the TSFN once the sink's clone is
    /// gone too.
    #[allow(dead_code)]
    tsfn: PreviewTsfn,
    detached: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl PreviewTap {
    /// Stop delivering to this tap's callback. Must run only after the native
    /// side no longer invokes the tap's sink. Dropping the last handle releases
    /// the TSFN (the sink holds the other one): queued items are still
    /// dispatched — and freed — but skip the user callback.
    fn detach(self) {
        self.detached
            .store(true, std::sync::atomic::Ordering::Release);
    }
}

/// At most this many preview frames wait for the JS thread. A stalled JS
/// thread drops previews instead of queueing ~330KB per frame without bound.
#[cfg(any(target_os = "macos", target_os = "windows"))]
const PREVIEW_QUEUE_SIZE: usize = 2;

/// `function (target, frame) { if (arguments.length > 1) target(frame) }`,
/// written in Rust. A TSFN always calls its JS function, so the user callback
/// is bound behind this: a detached delivery passes no frame and stops here.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn preview_dispatch(ctx: CallContext) -> Result<JsUndefined> {
    if ctx.length > 1 {
        let target: JsFunction = ctx.get(0)?;
        let frame: JsUnknown = ctx.get(1)?;
        // A throw propagates as the pending exception (uncaught, as before).
        target.call(None, &[frame])?;
    }
    ctx.env.get_undefined()
}

/// `preview_dispatch.bind(undefined, callback)`: the JS function the TSFN
/// calls. Bound (not a `Ref` held by Rust) so the TSFN alone keeps `callback`
/// alive and drops it at finalize — even if the sender is GC'd without
/// `stop()`.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn bind_preview_dispatch(env: &Env, callback: &JsFunction) -> Result<JsFunction> {
    let dispatch = env
        .create_function_from_closure("texturePreviewDispatch", preview_dispatch)?
        .coerce_to_object()?;
    let bind: JsFunction = dispatch.get_named_property("bind")?;
    let target = unsafe { JsUnknown::from_raw(env.raw(), callback.raw())? };
    let bound = bind.call(
        Some(&dispatch),
        &[env.get_undefined()?.into_unknown(), target],
    )?;
    Ok(unsafe { bound.cast::<JsFunction>() })
}

/// Wrap `callback` in an unref'd, gated ThreadsafeFunction and build the
/// native sink that feeds it. Bytes are copied twice on the way to JS: the
/// sink copies the borrowed readback into an owned Vec (the readback slot is
/// reused right after), and napi-rs copies that Vec into the JS Buffer
/// (`napi_create_buffer_copy`) because Electron forbids external buffers.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn create_preview_sink(
    env: &Env,
    callback: &JsFunction,
) -> Result<(PreviewTap, types::PreviewCallback)> {
    // Node's queue stays unbounded (0): its `queue_full` path leaks the payload
    // in napi-rs 2. `gate` enforces PREVIEW_QUEUE_SIZE before anything is
    // allocated or queued instead.
    let gate = std::sync::Arc::new(preview_gate::PreviewGate::new(PREVIEW_QUEUE_SIZE));
    let js_gate = gate.clone();
    let detached = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let js_detached = detached.clone();
    let dispatch = bind_preview_dispatch(env, callback)?;
    let mut tsfn: PreviewTsfn = dispatch.create_threadsafe_function(
        0,
        move |ctx: napi::threadsafe_function::ThreadSafeCallContext<PreviewPayload>| {
            // Every dispatched item returns its slot, stale or not.
            js_gate.release();
            if js_detached.load(std::sync::atomic::Ordering::Acquire) {
                // Freed here (dropped with `ctx`); the dispatcher sees no
                // frame and skips the callback.
                return Ok(vec![]);
            }
            Ok(vec![PreviewFrame {
                data: ctx.value.data.into(),
                width: ctx.value.width,
                height: ctx.value.height,
            }])
        },
    )?;
    // A preview tap must not keep the process alive on its own.
    tsfn.unref(env)?;
    let sink_tsfn = tsfn.clone();
    let sink: types::PreviewCallback = Box::new(move |bytes: &[u8], width: u32, height: u32| {
        // A full gate drops this preview frame (best-effort) before it is
        // copied. A failed call (the TSFN is being torn down with its env)
        // returns the slot so the count stays honest.
        if !gate.try_acquire() {
            return;
        }
        let status = sink_tsfn.call(
            PreviewPayload {
                data: bytes.to_vec(),
                width,
                height,
            },
            napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
        );
        if status != napi::Status::Ok {
            gate.release();
        }
    });
    Ok((PreviewTap { tsfn, detached }, sink))
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
        let inner = win::Sender::new(&name, width, height).map_err(|e| Error::from_reason(e))?;

        #[cfg(target_os = "macos")]
        let inner = mac::Sender::new(&name).map_err(|e| Error::from_reason(e))?;

        Ok(Self {
            inner: Some(inner),
            width,
            height,
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            preview_tap: None,
        })
    }

    /// Enable (callback) or disable (`null`) the downscaled preview tap.
    ///
    /// While enabled, every frame sent via `send` / `sendSurface` (and
    /// `sendRgbaBuffer` on macOS — it is not implemented on Windows) is also
    /// downscaled on the GPU, in the same submission as the Syphon/Spout
    /// send, and read back asynchronously (never stalls the send). The
    /// callback runs on the JS thread with a `PreviewFrame` (tightly packed
    /// RGBA, upright).
    ///
    /// Latency:
    /// - macOS: each preview is delivered as soon as the GPU finishes its
    ///   frame (Metal completion handler), independent of later sends.
    /// - Windows: D3D11 has no completion callback, so the readback is
    ///   polled — by the next `send` (typically one frame behind) or by
    ///   `pollPreview()`. Without either, the last frame of a sender that
    ///   stops sending is never delivered: call `pollPreview()` from a short
    ///   timer while it returns `true` (`createTextureBridge` does this).
    ///
    /// - macOS: the preview fits inside `maxWidth x maxHeight` with the aspect
    ///   ratio preserved (never upscaled).
    /// - Windows: the preview is the smallest power-of-two mip level of the
    ///   frame that still covers the fitted size (e.g. 480x270 for a 1080p
    ///   frame bounded by 384x216); `width` / `height` report the real size.
    ///
    /// Best-effort: a preview that cannot be produced for a frame is skipped;
    /// it never fails the send. Throws when the tap cannot be set up (invalid
    /// size, GPU pipeline failure, unsupported platform) or after `stop()`.
    /// Calling again replaces the previous callback / bounds; once this
    /// returns (or `stop()` returns) the previous callback is never invoked
    /// again, even for frames already queued for it. The tap never keeps the
    /// process alive.
    #[napi(
        ts_args_type = "maxWidth: number, maxHeight: number, callback: ((frame: PreviewFrame) => void) | null"
    )]
    #[cfg_attr(
        not(any(target_os = "macos", target_os = "windows")),
        allow(unused_variables)
    )]
    pub fn set_preview(
        &mut self,
        env: Env,
        max_width: u32,
        max_height: u32,
        callback: Option<JsFunction>,
    ) -> Result<()> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let inner = self
                .inner
                .as_mut()
                .ok_or_else(|| Error::from_reason("TextureSender has been stopped"))?;
            let Some(func) = callback else {
                inner
                    .set_preview(0, 0, None)
                    .map_err(|e| Error::from_reason(e))?;
                detach_preview(&mut self.preview_tap);
                return Ok(());
            };
            if max_width == 0 || max_height == 0 {
                return Err(Error::from_reason(
                    "setPreview: maxWidth and maxHeight must be positive",
                ));
            }
            let (tap, sink) = create_preview_sink(&env, &func)?;
            let result = inner.set_preview(max_width, max_height, Some(sink));
            if result.is_err() {
                // Leave the tap off rather than half-replaced: the platform
                // setters may refuse without touching the installed sink.
                let _ = inner.set_preview(0, 0, None);
            }
            // Either way the native side no longer invokes the previous sink
            // (replaced, or detached just above).
            detach_preview(&mut self.preview_tap);
            match result {
                Ok(()) => {
                    self.preview_tap = Some(tap);
                    Ok(())
                }
                Err(e) => {
                    tap.detach();
                    Err(Error::from_reason(e))
                }
            }
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Err(Error::from_reason(
                "setPreview is not supported on this platform",
            ))
        }
    }

    /// Deliver preview frames whose GPU readback finished since the last
    /// send, without sending a new frame. Returns `true` while a readback is
    /// still pending (call again later), `false` when there is nothing left
    /// to deliver.
    ///
    /// Only Windows needs this: D3D11 has no completion callback, so a
    /// preview is otherwise only picked up by the *next* send — the last
    /// frame of a sender that stops sending (a paused video, a static page)
    /// would never arrive. It maps finished slots with `DO_NOT_WAIT` and
    /// never waits on the GPU. On macOS it is a no-op that returns `false`
    /// (Metal completion handlers deliver every preview on their own).
    /// Also `false` when the tap is off, after `stop()`, and on unsupported
    /// platforms. `createTextureBridge` calls it automatically.
    #[napi]
    pub fn poll_preview(&mut self) -> bool {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            self.inner
                .as_ref()
                .is_some_and(|inner| inner.poll_preview())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            false
        }
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
        let inner = self
            .inner
            .as_mut()
            .ok_or_else(|| Error::from_reason("TextureSender has been stopped"))?;
        self.width = width;
        self.height = height;

        #[cfg(target_os = "windows")]
        {
            inner.send(handle).map_err(|e| Error::from_reason(e))?;
        }

        #[cfg(target_os = "macos")]
        {
            inner
                .send(handle, width, height)
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
        let inner = self
            .inner
            .as_mut()
            .ok_or_else(|| Error::from_reason("TextureSender has been stopped"))?;
        self.width = width;
        self.height = height;

        #[cfg(target_os = "macos")]
        {
            // Extract pointer from buffer (8 bytes = u64 pointer on 64-bit)
            if surface_buffer.len() < 8 {
                return Err(Error::from_reason("Surface buffer too small"));
            }
            let ptr_bytes: [u8; 8] = surface_buffer[..8]
                .try_into()
                .map_err(|_| Error::from_reason("Failed to read surface pointer"))?;
            let surface_ptr = u64::from_le_bytes(ptr_bytes);

            inner
                .send_surface(surface_ptr, width, height)
                .map_err(|e| Error::from_reason(e))?;
            Ok(())
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = (inner, surface_buffer);
            Err(Error::from_reason("send_surface is macOS only"))
        }
    }

    /// Stop the sender and release native resources immediately.
    /// This is a terminal operation — the sender cannot be reused afterward.
    /// Repeated calls are safe and idempotent.
    #[napi]
    pub fn stop(&mut self) -> Result<()> {
        // Drop the inner sender immediately, releasing native resources.
        // Subsequent calls are idempotent (inner is already None). Dropping
        // it drains in-flight sends and frees the preview sink, so the tap
        // can be detached below.
        self.inner.take();
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        detach_preview(&mut self.preview_tap);
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
        let inner = self
            .inner
            .as_mut()
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
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        return "unsupported".to_string();
    }
}

/// Detach the installed preview tap, if any (see `PreviewTap::detach`).
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn detach_preview(tap: &mut Option<PreviewTap>) {
    if let Some(tap) = tap.take() {
        tap.detach();
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

/// napi-rs object returned from `receiveSharedTexture()`.
///
/// Zero-copy GPU frame metadata, designed to be passed almost verbatim into
/// Electron's `sharedTexture.importSharedTexture({ textureInfo: ... })` in the
/// main process.
///
/// `handle` is an 8-byte little-endian encoding of the platform-native shared
/// resource descriptor:
/// - Windows: an NT HANDLE (freshly minted for this frame via
///   `DuplicateHandle`).
/// - macOS: an `IOSurfaceRef` pointer (retained once by this call).
///
/// **Ownership contract.** The handle is fresh per frame and is always owned by
/// the caller, who MUST pass it to `closeNativeHandle()` exactly once —
/// whether or not it was imported. `sharedTexture.importSharedTexture` never
/// takes ownership: it duplicates the NT HANDLE (Windows) or retains the
/// IOSurface (macOS) into its own reference, so `closeNativeHandle()` is safe
/// immediately after the import call returns (success or throw). Skipping it
/// leaks one NT HANDLE / IOSurface retain per frame.
///
/// The `ownerPid` field is the process ID in which the handle is valid, so
/// Chromium's GPU process can duplicate it correctly.
#[napi(object)]
pub struct SharedTextureFrame {
    pub width: u32,
    pub height: u32,
    /// Subset of Electron's `SharedTextureImportTextureInfo.pixelFormat` values
    /// that this receiver ever emits: `"bgra" | "rgba" | "rgbaf16"`. Kept in
    /// lockstep with `dxgi_format_to_pixel_format` (Windows) and
    /// `SharedIoSurfaceInfo::pixel_format_string` (macOS).
    pub pixel_format: String,
    /// Process ID that owns the handle. Almost always `process.pid` of the
    /// Node process that called `receiveSharedTexture`.
    pub owner_pid: u32,
    /// 8-byte little-endian encoding of the platform-native handle/pointer.
    pub handle: napi::bindgen_prelude::Buffer,
}

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

/// Build the JS frame object for a macOS shared IOSurface on the poll path
/// (`receiveSharedTexture`). Emits the same 8-byte LE handle encoding and
/// `ownerPid` as the push path's `PushFrame::into_shared_texture_frame`.
#[cfg(target_os = "macos")]
fn shared_texture_frame_from_iosurface(
    info: &mac::receiver::SharedIoSurfaceInfo,
) -> SharedTextureFrame {
    SharedTextureFrame {
        width: info.width,
        height: info.height,
        pixel_format: info.pixel_format_string(),
        owner_pid: std::process::id(),
        handle: info.iosurface_ptr.to_le_bytes().to_vec().into(),
    }
}

/// Native receiver / frame types the push path is generic over. Each platform
/// receiver exposes the same `set_frame_callback` shape; only the frame
/// metadata and how an unconsumed handle is closed differ.
#[cfg(target_os = "macos")]
type NativeReceiver = mac::receiver::Receiver;
#[cfg(target_os = "macos")]
type NativeFrameCallback = mac::receiver::FrameCallback;
#[cfg(target_os = "macos")]
type NativeFrameInfo = mac::receiver::SharedIoSurfaceInfo;
#[cfg(target_os = "windows")]
type NativeReceiver = win::receiver::Receiver;
#[cfg(target_os = "windows")]
type NativeFrameCallback = win::receiver::FrameCallback;
#[cfg(target_os = "windows")]
type NativeFrameInfo = win::receiver::SharedTextureHandleInfo;

/// Platform-neutral push frame in transit from the native thread to JS. The
/// pixel format is resolved on the native side so the JS-thread conversion
/// cannot fail.
#[cfg(any(target_os = "macos", target_os = "windows"))]
struct PushFrame {
    handle: u64,
    width: u32,
    height: u32,
    pixel_format: String,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl PushFrame {
    /// Same 8-byte LE handle encoding and `ownerPid` as `receiveSharedTexture`.
    fn into_shared_texture_frame(self) -> SharedTextureFrame {
        SharedTextureFrame {
            width: self.width,
            height: self.height,
            pixel_format: self.pixel_format,
            owner_pid: std::process::id(),
            handle: self.handle.to_le_bytes().to_vec().into(),
        }
    }
}

/// Describe a natively staged frame for JS. `Err(handle)` means it cannot be
/// described to Electron; the caller still owns `handle` and must close it.
#[cfg(target_os = "macos")]
fn push_frame_from_native(info: NativeFrameInfo) -> std::result::Result<PushFrame, u64> {
    Ok(PushFrame {
        handle: info.iosurface_ptr,
        width: info.width,
        height: info.height,
        pixel_format: info.pixel_format_string(),
    })
}

#[cfg(target_os = "windows")]
fn push_frame_from_native(info: NativeFrameInfo) -> std::result::Result<PushFrame, u64> {
    match dxgi_format_to_pixel_format(info.format) {
        Ok(pixel_format) => Ok(PushFrame {
            handle: info.nt_handle,
            width: info.width,
            height: info.height,
            pixel_format: pixel_format.to_string(),
        }),
        Err(_) => Err(info.nt_handle),
    }
}

/// Release a pushed handle that will never reach JS.
#[cfg(target_os = "macos")]
fn close_pending_handle(handle: u64) {
    let _ = mac::close_shared_iosurface(handle);
}

#[cfg(target_os = "windows")]
fn close_pending_handle(handle: u64) {
    let _ = win::close_shared_handle(handle);
}

/// Native handles (IOSurface pointers / NT HANDLEs) queued on the push TSFN
/// but not yet handed to JS. Each is owned by whoever would receive it; on
/// unsubscribe the aborted TSFN never dispatches them, so they are released
/// from here instead.
#[cfg(any(target_os = "macos", target_os = "windows"))]
type PendingHandles = std::sync::Arc<std::sync::Mutex<Vec<u64>>>;

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn lock_pending(pending: &PendingHandles) -> std::sync::MutexGuard<'_, Vec<u64>> {
    pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Remove one occurrence of `handle` from the pending list. Returns whether
/// it was present (i.e. whether the caller now owns it).
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn take_pending(pending: &PendingHandles, handle: u64) -> bool {
    let mut guard = lock_pending(pending);
    match guard.iter().position(|&p| p == handle) {
        Some(index) => {
            guard.swap_remove(index);
            true
        }
        None => false,
    }
}

/// One `onSharedTexture` subscription: the JS callback wrapped in a
/// ThreadsafeFunction plus the frames queued on it.
///
/// Must be dropped only after the native receiver stopped invoking the sink
/// (`Receiver::set_frame_callback(None)` or `destroy`). Dropping aborts the
/// TSFN — Node never dispatches queued items of an aborted TSFN, so no JS
/// callback fires afterwards — and releases every still-queued handle.
#[cfg(any(target_os = "macos", target_os = "windows"))]
struct PushSubscription {
    tsfn: Option<
        napi::threadsafe_function::ThreadsafeFunction<
            PushFrame,
            napi::threadsafe_function::ErrorStrategy::Fatal,
        >,
    >,
    pending: PendingHandles,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl PushSubscription {
    fn new(callback: &JsFunction) -> Result<Self> {
        let pending: PendingHandles = Default::default();
        let pending_js = pending.clone();
        // Runs on the JS thread right before the callback is invoked: from
        // here on JS owns the handle.
        let tsfn = callback.create_threadsafe_function(
            0,
            move |ctx: napi::threadsafe_function::ThreadSafeCallContext<PushFrame>| {
                take_pending(&pending_js, ctx.value.handle);
                Ok(vec![ctx.value.into_shared_texture_frame()])
            },
        )?;
        Ok(Self {
            tsfn: Some(tsfn),
            pending,
        })
    }

    /// Native-side sink: runs on the platform's push thread (Metal completion
    /// thread / Spout push worker), queues the frame to JS without blocking,
    /// and releases the handle if it cannot be described or queued.
    fn frame_sink(&self) -> Option<NativeFrameCallback> {
        let tsfn = self.tsfn.as_ref()?.clone();
        let pending = self.pending.clone();
        let logged_unsupported = std::sync::atomic::AtomicBool::new(false);
        Some(Box::new(move |info: NativeFrameInfo| {
            let frame = match push_frame_from_native(info) {
                Ok(frame) => frame,
                Err(handle) => {
                    if !logged_unsupported.swap(true, std::sync::atomic::Ordering::Relaxed) {
                        eprintln!(
                            "[texture-bridge] onSharedTexture: dropping frames with an unsupported pixel format"
                        );
                    }
                    close_pending_handle(handle);
                    return;
                }
            };
            let handle = frame.handle;
            lock_pending(&pending).push(handle);
            let status = tsfn.call(
                frame,
                napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
            );
            if status != Status::Ok && take_pending(&pending, handle) {
                close_pending_handle(handle);
            }
        }))
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl Drop for PushSubscription {
    fn drop(&mut self) {
        if let Some(tsfn) = self.tsfn.take() {
            let _ = tsfn.abort();
        }
        let leftovers = std::mem::take(&mut *lock_pending(&self.pending));
        for handle in leftovers {
            close_pending_handle(handle);
        }
    }
}

/// Stop native push delivery, then tear the subscription down. Order matters:
/// the native unsubscribe guarantees the sink is no longer running before the
/// TSFN is aborted and queued handles are released.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn detach_push(inner: &mut NativeReceiver, push: &mut Option<PushSubscription>) {
    inner.set_frame_callback(None);
    push.take();
}

#[napi]
pub struct TextureReceiver {
    #[cfg(target_os = "macos")]
    inner: Option<mac::receiver::Receiver>,
    #[cfg(target_os = "windows")]
    inner: Option<win::receiver::Receiver>,
    /// Declared after `inner` so an un-stopped receiver drops (destroys) the
    /// native side before the subscription.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    push: Option<PushSubscription>,

    #[allow(dead_code)]
    sender_name: String,
    #[cfg(target_os = "macos")]
    #[allow(dead_code)]
    app_name: Option<String>,
    #[cfg(target_os = "macos")]
    #[allow(dead_code)]
    server_uuid: Option<String>,
}

#[napi]
impl TextureReceiver {
    /// Create a new texture receiver.
    ///
    /// - `sender_name`: Name of the Syphon server / Spout sender to connect to
    /// - `app_name`: (macOS only) Filter by application name
    /// - `server_uuid`: (macOS only) Connect by server UUID (highest priority)
    #[napi(constructor)]
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
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
        let inner =
            win::receiver::Receiver::new(&sender_name).map_err(|e| Error::from_reason(e))?;

        let result = Self {
            inner: Some(inner),
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            push: None,
            sender_name,
            #[cfg(target_os = "macos")]
            app_name,
            #[cfg(target_os = "macos")]
            server_uuid,
        };

        Ok(result)
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
    pub fn receive_frame(&mut self) -> Result<Option<ReceivedFrame>> {
        let inner = match &mut self.inner {
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

    /// Receive the current frame as a GPU-shared texture descriptor.
    ///
    /// Returns `null` if no new frame is available or if `stop()` has been called.
    /// The returned object can be handed to Electron's
    /// `sharedTexture.importSharedTexture` after wrapping the `handle` Buffer
    /// under the appropriate platform key (`ntHandle` on Windows,
    /// `ioSurface` on macOS). The caller must then pass `handle` to
    /// `closeNativeHandle()` exactly once (see `SharedTextureFrame`).
    #[napi]
    pub fn receive_shared_texture(&self) -> Result<Option<SharedTextureFrame>> {
        let inner = match &self.inner {
            Some(r) => r,
            None => return Ok(None),
        };

        #[cfg(target_os = "windows")]
        {
            match inner.receive_shared_texture() {
                Ok(Some(info)) => {
                    let pixel_format = dxgi_format_to_pixel_format(info.format)
                        .map_err(|e| Error::from_reason(e))?;
                    let mut bytes = vec![0u8; 8];
                    bytes.copy_from_slice(&info.nt_handle.to_le_bytes());
                    Ok(Some(SharedTextureFrame {
                        width: info.width,
                        height: info.height,
                        pixel_format: pixel_format.to_string(),
                        owner_pid: std::process::id(),
                        handle: bytes.into(),
                    }))
                }
                Ok(None) => Ok(None),
                Err(e) => Err(Error::from_reason(e)),
            }
        }

        #[cfg(target_os = "macos")]
        {
            match inner.receive_shared_iosurface() {
                Ok(Some(info)) => Ok(Some(shared_texture_frame_from_iosurface(&info))),
                Ok(None) => Ok(None),
                Err(e) => Err(Error::from_reason(e)),
            }
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
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            detach_push(&mut r, &mut self.push);
            r.destroy();
        }
        Ok(())
    }

    /// Subscribe to frames pushed as soon as they are staged on the GPU
    /// (macOS: Syphon; Windows: Spout), instead of polling
    /// `receiveSharedTexture`.
    ///
    /// The callback runs on the JS thread with a `SharedTextureFrame` whose
    /// `handle` follows the same ownership contract as `receiveSharedTexture`:
    /// pass it to `closeNativeHandle()` exactly once, also after
    /// `importSharedTexture` (Electron keeps its own reference). Frames are
    /// staged into a 3-slot ring; when no slot is free the frame is dropped
    /// natively. On macOS a slot counts as held while it is retained beyond
    /// the ring's own reference or `IOSurfaceIsInUse` reports it in use
    /// downstream; on Windows a slot is effectively free once the caller
    /// closes its handle, so the ring round-robins over its 3 slots. Passing `null` unsubscribes; calling again
    /// replaces the previous callback. After `stop()` returns no callback
    /// fires. While subscribed, the receiver keeps the event loop alive.
    ///
    /// Throws `"TextureReceiver has been stopped"` after `stop()`, and
    /// `"onSharedTexture is not supported on this platform"` elsewhere.
    #[napi(ts_args_type = "callback: ((frame: SharedTextureFrame) => void) | null")]
    #[cfg_attr(
        not(any(target_os = "macos", target_os = "windows")),
        allow(unused_variables)
    )]
    pub fn on_shared_texture(&mut self, callback: Option<JsFunction>) -> Result<()> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let inner = self
                .inner
                .as_mut()
                .ok_or_else(|| Error::from_reason("TextureReceiver has been stopped"))?;
            detach_push(inner, &mut self.push);
            let Some(func) = callback else {
                return Ok(());
            };
            let subscription = PushSubscription::new(&func)?;
            inner.set_frame_callback(subscription.frame_sink());
            self.push = Some(subscription);
            Ok(())
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Err(Error::from_reason(
                "onSharedTexture is not supported on this platform",
            ))
        }
    }

    /// Toggle whether `receiveSharedTexture` applies a vertical flip when
    /// staging the frame for `importSharedTexture`. Defaults to `true`
    /// (matches PR #46 behavior, suitable for `drawImage(VideoFrame)` /
    /// WebGPU `importExternalTexture` consumers expecting Y-DOWN). Pass
    /// `false` when the upstream Syphon source already publishes the
    /// orientation Electron's `importSharedTexture` expects.
    ///
    /// macOS only — a no-op on Windows (Spout's receive path does not have
    /// a flip stage).
    #[napi]
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
    pub fn set_flip_y(&self, flip: bool) -> Result<()> {
        #[cfg(target_os = "macos")]
        if let Some(r) = &self.inner {
            r.set_flip_y(flip);
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
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        return "unsupported".to_string();
    }
}

/// Map a raw `DXGI_FORMAT` value to an Electron-compatible pixel format string.
///
/// Currently supports the formats Chromium/Electron accepts in
/// `SharedTextureImportTextureInfo.pixelFormat`. Returns `Err` for unknown
/// formats so the caller can surface a useful error rather than silently
/// lying about the texture layout.
#[cfg(target_os = "windows")]
fn dxgi_format_to_pixel_format(format: u32) -> std::result::Result<&'static str, String> {
    // DXGI_FORMAT values:
    //   87 = DXGI_FORMAT_B8G8R8A8_UNORM
    //   28 = DXGI_FORMAT_R8G8B8A8_UNORM
    //   10 = DXGI_FORMAT_R16G16B16A16_FLOAT
    match format {
        87 => Ok("bgra"),
        28 => Ok("rgba"),
        10 => Ok("rgbaf16"),
        other => Err(format!(
            "Unsupported DXGI_FORMAT for shared texture: {other}"
        )),
    }
}

/// Release the caller's reference on a native shared texture handle (NT HANDLE
/// on Windows, IOSurfaceRef on macOS) minted by receiveSharedTexture(). Call
/// exactly once per handle — after importSharedTexture returns (Electron keeps
/// its own duplicated / retained reference) or instead of importing it.
/// Buffer must be 8 bytes LE.
#[napi]
pub fn close_native_handle(handle: napi::bindgen_prelude::Buffer) -> Result<()> {
    if handle.len() != 8 {
        return Err(Error::from_reason(format!(
            "close_native_handle: expected 8-byte buffer, got {}",
            handle.len()
        )));
    }
    let bytes: [u8; 8] = handle[..8]
        .try_into()
        .map_err(|_| Error::from_reason("Failed to read 8-byte handle buffer"))?;
    let raw = u64::from_le_bytes(bytes);

    #[cfg(target_os = "windows")]
    {
        win::close_shared_handle(raw).map_err(|e| Error::from_reason(e))?;
    }

    #[cfg(target_os = "macos")]
    {
        mac::close_shared_iosurface(raw).map_err(|e| Error::from_reason(e))?;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = raw;
        return Err(Error::from_reason(
            "close_native_handle is not supported on this platform",
        ));
    }

    Ok(())
}

/// List all available texture senders (Syphon servers / Spout senders).
#[napi]
pub fn list_senders() -> Result<Vec<JsSenderInfo>> {
    #[cfg(target_os = "macos")]
    let json = mac::receiver::list_servers_json().map_err(|e| Error::from_reason(e))?;

    #[cfg(target_os = "windows")]
    let json = win::receiver::list_senders_json().map_err(|e| Error::from_reason(e))?;

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let json = "[]".to_string();

    let infos = parse_senders_json(&json).map_err(|e| Error::from_reason(e))?;

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

    #[cfg(target_os = "windows")]
    #[test]
    fn dxgi_format_bgra_maps_to_bgra_string() {
        assert_eq!(dxgi_format_to_pixel_format(87).unwrap(), "bgra");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dxgi_format_rgba_maps_to_rgba_string() {
        assert_eq!(dxgi_format_to_pixel_format(28).unwrap(), "rgba");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dxgi_format_rgba16f_maps_to_rgbaf16_string() {
        assert_eq!(dxgi_format_to_pixel_format(10).unwrap(), "rgbaf16");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dxgi_format_unknown_returns_error() {
        assert!(dxgi_format_to_pixel_format(0).is_err());
        assert!(dxgi_format_to_pixel_format(999).is_err());
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
