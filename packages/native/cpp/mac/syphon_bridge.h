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
