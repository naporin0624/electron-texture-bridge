use std::os::raw::c_char;

pub type SpoutBridgeHandle = *mut std::ffi::c_void;

extern "C" {
    pub fn spout_bridge_create(name: *const c_char, width: u32, height: u32) -> SpoutBridgeHandle;
    pub fn spout_bridge_destroy(handle: SpoutBridgeHandle);
    pub fn spout_bridge_send(handle: SpoutBridgeHandle, shared_handle: i64) -> i32;
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
    pub fn spout_receiver_is_connected(handle: SpoutReceiverHandle) -> i32;
    pub fn spout_receiver_get_width(handle: SpoutReceiverHandle) -> u32;
    pub fn spout_receiver_get_height(handle: SpoutReceiverHandle) -> u32;

    // ---- Discovery ----
    pub fn spout_discovery_get_sender_count() -> i32;
    pub fn spout_discovery_get_sender_name(
        index: i32,
        out_name: *mut c_char,
        name_size: u32,
    ) -> i32;

    // ---- Consolidated Discovery ----
    pub fn spout_discovery_list_senders() -> *mut c_char;
    pub fn spout_discovery_free_string(str: *mut c_char);
}

pub type SpoutReceiverHandle = *mut std::ffi::c_void;
