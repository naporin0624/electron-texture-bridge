#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Opaque handle
typedef void* SyphonBridgeHandle;

// Lifecycle
SyphonBridgeHandle syphon_bridge_create(const char* name);
void               syphon_bridge_destroy(SyphonBridgeHandle handle);

// Send an IOSurface by its IOSurfaceID
// surface_id: IOSurfaceID from Electron's useSharedTexture handle
// width, height: texture dimensions (from textureInfo.codedSize)
// Returns: 0 on success, -1 on error
int syphon_bridge_send(SyphonBridgeHandle handle,
                       uint32_t surface_id,
                       uint32_t width,
                       uint32_t height);

// Send an IOSurface by direct pointer (IOSurfaceRef)
// surface: IOSurfaceRef pointer from Electron's shared texture handle buffer
// width, height: texture dimensions (from textureInfo.codedSize)
// Returns: 0 on success, -1 on error
int syphon_bridge_send_surface(SyphonBridgeHandle handle,
                               void* surface,
                               uint32_t width,
                               uint32_t height);

// Send raw RGBA buffer data (for VideoFrame.copyTo() workflow)
// data: pointer to RGBA pixel data (4 bytes per pixel, BGRA format expected)
// width, height: texture dimensions
// bytes_per_row: stride in bytes (typically width * 4, but may include padding)
// Returns: 0 on success, -1 on error
int syphon_bridge_send_rgba(SyphonBridgeHandle handle,
                            const uint8_t* data,
                            uint32_t width,
                            uint32_t height,
                            uint32_t bytes_per_row);

// ============================================================
// Receiver (SyphonMetalClient)
// ============================================================

typedef void* SyphonReceiverHandle;

// Create a receiver connected to a Syphon server.
// Pass NULL for any parameter to skip that filter.
// server_uuid takes highest priority, then server_name + app_name.
SyphonReceiverHandle syphon_receiver_create(const char* server_uuid,
                                             const char* server_name,
                                             const char* app_name);
void     syphon_receiver_destroy(SyphonReceiverHandle handle);

// Returns 1 if the server has output a new frame, 0 otherwise.
int      syphon_receiver_has_new_frame(SyphonReceiverHandle handle);

// Receive the current frame as RGBA pixel data.
// out_buffer must be at least buffer_size bytes.
// out_width/out_height are set to the actual texture dimensions.
// Returns 0 on success, -1 on error (no frame, buffer too small, etc.)
int      syphon_receiver_receive_rgba(SyphonReceiverHandle handle,
                                       uint8_t* out_buffer, uint32_t buffer_size,
                                       uint32_t* out_width, uint32_t* out_height);

// Returns 1 if the client has a valid connection, 0 otherwise.
int      syphon_receiver_is_valid(SyphonReceiverHandle handle);

// Returns the width of the last received texture (0 if none).
uint32_t syphon_receiver_get_width(SyphonReceiverHandle handle);

// Returns the height of the last received texture (0 if none).
uint32_t syphon_receiver_get_height(SyphonReceiverHandle handle);

// Receive the current frame as an IOSurface pointer (zero-copy for GPU consumers).
//
// On success the frame is blitted into a per-receiver staging IOSurface-backed
// MTLTexture and a CFRetained IOSurfaceRef of that staging texture is written
// to *out_iosurface. The staging IOSurface is owned by this bridge — we hand
// out a fresh retain per frame that the caller balances with exactly one
// native_close_shared_iosurface — also after Electron's importSharedTexture,
// which takes its own retain instead of adopting this one. This
// mirrors the Windows receiver's per-frame DuplicateHandle pattern: callers
// never see Syphon's pool-recycled texture directly.
//
// out_pixel_format is one of:
//   0 = "bgra"
//   1 = "rgba"
//   2 = "rgbaf16"
//
// Return codes (kept in lockstep with spout_receiver_receive_shared_texture):
//   0 = frame received successfully
//   1 = no new frame (poll again later)
//   2 = dimensions or pixel format changed; staging was just (re)allocated and
//       no frame was blitted yet. out_width/out_height/out_pixel_format hold
//       the new dims; caller should poll again on the next tick.
//  -1 = not connected / no valid client
//  -2 = texture is not IOSurface-backed (should not occur for Syphon clients)
//  -3 = Syphon texture pixel format is not one we map to an Electron-compatible
//       string. Ensures we never lie about a texture's layout to
//       importSharedTexture.
int syphon_receiver_receive_shared_iosurface(SyphonReceiverHandle handle,
                                             void** out_iosurface,
                                             uint32_t* out_width,
                                             uint32_t* out_height,
                                             uint32_t* out_pixel_format);

// Toggle the receive-side Y-flip pass on/off. flip != 0 enables the
// fullscreen Y-flip render pipeline (default — matches PR #46 behavior, used
// when the consumer expects Y-DOWN image-coord layout). flip == 0 falls back
// to a straight blit that preserves orientation, for downstream apps whose
// upstream Syphon source already publishes the orientation Electron's
// importSharedTexture expects.
void syphon_receiver_set_flip_y(SyphonReceiverHandle handle, int flip);

// ============================================================
// Push receive path (staging ring + frame callback)
// ============================================================

// Invoked on a Metal command-buffer completion thread once a frame has been
// staged (GPU→GPU) into one of the receiver's ring IOSurfaces and the staging
// command buffer has completed. `iosurface` is an IOSurfaceRef carrying exactly
// one CFRetain owned by the callee — balance it via Electron's imported
// texture release or native_close_shared_iosurface. pixel_format_code uses the
// same table as syphon_receiver_receive_shared_iosurface (0 bgra, 1 rgba,
// 2 rgbaf16). Must not block: it runs while the receiver's callback mutex is
// held.
typedef void (*syphon_frame_callback)(void* ctx,
                                      void* iosurface,
                                      uint32_t width,
                                      uint32_t height,
                                      uint32_t pixel_format_code);

// Subscribe (cb != NULL) or unsubscribe (cb == NULL) the push path. While
// subscribed, every Syphon new-frame notification is staged into a free slot
// of a 3-slot IOSurface ring without waiting on the GPU; frames are dropped
// when every slot is still held by a consumer. Thread-safe with respect to the
// Syphon handler and completion handlers: once this returns with cb == NULL,
// no further invocation of the previous callback happens and none is running.
// The poll path (syphon_receiver_receive_shared_iosurface) is unaffected.
void syphon_receiver_set_frame_callback(SyphonReceiverHandle handle,
                                        syphon_frame_callback cb,
                                        void* ctx);

// Pure helper: returns the first index i in [0, n) with retain_counts[i] == 1
// (only the bridge holds the slot) and gpu_busy[i] == 0, else -1.
int32_t syphon_ring_pick_slot(const uint32_t* retain_counts,
                              const uint8_t* gpu_busy,
                              uint32_t n);

// ============================================================
// Pixel format utilities
// ============================================================

// Convert BGRA pixel data to RGBA in-place or between buffers.
// src and dst may be the same pointer for in-place conversion.
// pixel_count: number of pixels (NOT bytes — each pixel is 4 bytes).
void syphon_convert_bgra_to_rgba(const uint8_t* src, uint8_t* dst, uint32_t pixel_count);

// Map an IOSurface OSType pixel format to a Metal pixel format enum value.
// Returns the underlying uint64_t value of MTLPixelFormat.
// Known mappings:
//   kCVPixelFormatType_32RGBA (0x52474241) → MTLPixelFormatRGBA8Unorm (70)
//   kCVPixelFormatType_32BGRA ('BGRA')     → MTLPixelFormatBGRA8Unorm (80)
//   Unknown formats                        → MTLPixelFormatBGRA8Unorm (80, default)
uint64_t syphon_map_pixel_format(uint32_t iosurface_pixel_format);

// Release a raw IOSurfaceRef minted by syphon_receiver_receive_shared_iosurface.
// Call exactly once per surface: after Electron's importSharedTexture returns
// (Electron retains its own reference), or instead of importing it.
// Returns 0 on success, -1 if the pointer is null.
int32_t native_close_shared_iosurface(uintptr_t raw_ptr);

// ============================================================
// Discovery (SyphonServerDirectory)
// ============================================================

// Returns a JSON string describing all available Syphon servers.
// Format: [{"name":"...","appName":"...","uuid":"..."},...]
// Caller must free the returned string with syphon_discovery_free_string().
char*    syphon_discovery_list_servers(void);

// Free a string returned by syphon_discovery_list_servers().
void     syphon_discovery_free_string(char* str);

#ifdef __cplusplus
}
#endif
