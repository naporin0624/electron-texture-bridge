use std::os::raw::c_char;

pub type SyphonBridgeHandle = *mut std::ffi::c_void;
pub type IOSurfaceRef = *mut std::ffi::c_void;

extern "C" {
    pub fn syphon_bridge_create(name: *const c_char) -> SyphonBridgeHandle;
    pub fn syphon_bridge_destroy(handle: SyphonBridgeHandle);
    pub fn syphon_bridge_send(
        handle: SyphonBridgeHandle,
        surface_id: u32,
        width: u32,
        height: u32,
    ) -> i32;
    /// Send IOSurface via direct pointer (from Electron's shared texture handle)
    pub fn syphon_bridge_send_surface(
        handle: SyphonBridgeHandle,
        surface: IOSurfaceRef,
        width: u32,
        height: u32,
    ) -> i32;
    pub fn syphon_bridge_send_rgba(
        handle: SyphonBridgeHandle,
        data: *const u8,
        width: u32,
        height: u32,
        bytes_per_row: u32,
    ) -> i32;

    // ---- Sender preview tap ----
    pub fn syphon_bridge_set_preview(
        handle: SyphonBridgeHandle,
        max_width: u32,
        max_height: u32,
        cb: Option<SyphonPreviewCallback>,
        ctx: *mut std::ffi::c_void,
    ) -> i32;
    #[allow(dead_code)]
    pub fn syphon_preview_fit_size(
        src_w: u32,
        src_h: u32,
        max_w: u32,
        max_h: u32,
        out_w: *mut u32,
        out_h: *mut u32,
    );
    #[allow(dead_code)]
    pub fn syphon_preview_taps(src: u32, dst: u32) -> u32;
    #[allow(dead_code)]
    pub fn syphon_bridge_texture_cache_count(handle: SyphonBridgeHandle) -> u32;
    #[allow(dead_code)]
    pub fn syphon_debug_create_split_iosurface(
        width: u32,
        height: u32,
        top_bgra: u32,
        bottom_bgra: u32,
    ) -> IOSurfaceRef;

    // ---- Receiver ----
    pub fn syphon_receiver_create(
        server_uuid: *const c_char,
        server_name: *const c_char,
        app_name: *const c_char,
    ) -> SyphonReceiverHandle;
    pub fn syphon_receiver_destroy(handle: SyphonReceiverHandle);
    #[allow(dead_code)]
    pub fn syphon_debug_receiver_create_for_server(
        sender: SyphonBridgeHandle,
    ) -> SyphonReceiverHandle;
    pub fn syphon_receiver_has_new_frame(handle: SyphonReceiverHandle) -> i32;
    pub fn syphon_receiver_receive_rgba(
        handle: SyphonReceiverHandle,
        out_buffer: *mut u8,
        buffer_size: u32,
        out_width: *mut u32,
        out_height: *mut u32,
    ) -> i32;
    pub fn syphon_receiver_is_valid(handle: SyphonReceiverHandle) -> i32;
    pub fn syphon_receiver_get_width(handle: SyphonReceiverHandle) -> u32;
    pub fn syphon_receiver_get_height(handle: SyphonReceiverHandle) -> u32;
    pub fn syphon_receiver_receive_shared_iosurface(
        handle: SyphonReceiverHandle,
        out_iosurface: *mut *mut std::ffi::c_void,
        out_width: *mut u32,
        out_height: *mut u32,
        out_pixel_format: *mut u32,
    ) -> i32;
    pub fn syphon_receiver_set_flip_y(handle: SyphonReceiverHandle, flip: i32);
    pub fn syphon_receiver_set_frame_callback(
        handle: SyphonReceiverHandle,
        cb: Option<SyphonFrameCallback>,
        ctx: *mut std::ffi::c_void,
    );
    /// Pure ring-slot picker (used by the C++ push path + Rust tests).
    #[allow(dead_code)]
    pub fn syphon_ring_pick_slot(retain_counts: *const u32, gpu_busy: *const u8, n: u32) -> i32;

    // ---- Discovery ----
    pub fn syphon_discovery_list_servers() -> *mut c_char;
    pub fn syphon_discovery_free_string(str: *mut c_char);

    // ---- Pixel format utilities (used by C++ internally + Rust tests) ----
    #[allow(dead_code)]
    pub fn syphon_convert_bgra_to_rgba(src: *const u8, dst: *mut u8, pixel_count: u32);
    #[allow(dead_code)]
    pub fn syphon_map_pixel_format(iosurface_pixel_format: u32) -> u64;

    // ---- Shared-handle lifecycle ----
    pub fn native_close_shared_iosurface(raw_ptr: usize) -> i32;
}

pub type SyphonReceiverHandle = *mut std::ffi::c_void;

/// Push-path frame callback. Invoked on a Metal completion thread with an
/// IOSurfaceRef that carries exactly one CFRetain owned by the callee.
pub type SyphonFrameCallback = unsafe extern "C" fn(
    ctx: *mut std::ffi::c_void,
    iosurface: *mut std::ffi::c_void,
    width: u32,
    height: u32,
    pixel_format_code: u32,
);

/// Sender preview callback. Invoked on a Metal completion thread with
/// `width * height * 4` tightly packed, upright RGBA bytes that are only valid
/// for the duration of the call.
pub type SyphonPreviewCallback =
    unsafe extern "C" fn(ctx: *mut std::ffi::c_void, rgba: *const u8, width: u32, height: u32);
