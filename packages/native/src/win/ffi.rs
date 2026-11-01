use std::os::raw::c_char;

pub type SpoutBridgeHandle = *mut std::ffi::c_void;

extern "C" {
    pub fn spout_bridge_create(name: *const c_char, width: u32, height: u32) -> SpoutBridgeHandle;
    pub fn spout_bridge_destroy(handle: SpoutBridgeHandle);
    pub fn spout_bridge_send(handle: SpoutBridgeHandle, shared_handle: i64) -> i32;
    #[allow(dead_code)]
    pub fn spout_bridge_resize(handle: SpoutBridgeHandle, width: u32, height: u32) -> i32;

    // ---- Receiver ----
    pub fn spout_receiver_create(sender_name: *const c_char) -> SpoutReceiverHandle;
    pub fn spout_receiver_destroy(handle: SpoutReceiverHandle);
    pub fn spout_receiver_has_new_frame(handle: SpoutReceiverHandle) -> i32;
    pub fn spout_receiver_receive_rgba(
        handle: SpoutReceiverHandle,
        out_buffer: *mut u8,
        buffer_size: u32,
        out_width: *mut u32,
        out_height: *mut u32,
    ) -> i32;
    pub fn spout_receiver_receive_shared_texture(
        handle: SpoutReceiverHandle,
        out_nt_handle: *mut *mut std::ffi::c_void,
        out_width: *mut u32,
        out_height: *mut u32,
        out_format: *mut u32,
    ) -> i32;
    pub fn spout_receiver_is_connected(handle: SpoutReceiverHandle) -> i32;
    pub fn spout_receiver_get_width(handle: SpoutReceiverHandle) -> u32;
    pub fn spout_receiver_get_height(handle: SpoutReceiverHandle) -> u32;
    pub fn spout_receiver_set_frame_callback(
        handle: SpoutReceiverHandle,
        cb: Option<SpoutFrameCallback>,
        ctx: *mut std::ffi::c_void,
    );
    /// Pure ring-slot picker (used by the C++ push path + Rust tests).
    #[allow(dead_code)]
    pub fn spout_ring_pick_slot(held: *const u8, gpu_busy: *const u8, n: u32) -> i32;

    // ---- Discovery ----
    pub fn spout_discovery_list_senders() -> *mut c_char;
    pub fn spout_discovery_free_string(str: *mut c_char);

    // ---- Shared-handle lifecycle ----
    pub fn native_close_shared_handle(raw_handle: usize) -> i32;
}

pub type SpoutReceiverHandle = *mut std::ffi::c_void;

/// Push-path frame callback. Invoked on the receiver's push worker thread with
/// a freshly duplicated NT HANDLE owned by the callee, once the staging copy
/// into a ring slot has completed on the GPU. `dxgi_format` is the raw
/// `DXGI_FORMAT` of the staged texture.
pub type SpoutFrameCallback = unsafe extern "C" fn(
    ctx: *mut std::ffi::c_void,
    nt_handle: *mut std::ffi::c_void,
    width: u32,
    height: u32,
    dxgi_format: u32,
);
