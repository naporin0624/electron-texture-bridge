// spout_bridge.cpp
// C++ bridge for Rust FFI to Spout2 SDK

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <d3d11_1.h>
#include "SpoutDX.h"

struct SpoutBridge {
    spoutDX sender;
    ID3D11Device* device;
    ID3D11Device1* device1;  // For OpenSharedResource1 (NT handles)
    ID3D11DeviceContext* context;
    unsigned int width;
    unsigned int height;
    bool initialized;
};

extern "C" {

void* spout_bridge_create(const char* name, uint32_t width, uint32_t height) {
    SpoutBridge* bridge = new SpoutBridge();
    bridge->width = width;
    bridge->height = height;
    bridge->initialized = false;
    bridge->device = nullptr;
    bridge->device1 = nullptr;
    bridge->context = nullptr;

    // Initialize DirectX 11
    if (!bridge->sender.OpenDirectX11()) {
        delete bridge;
        return nullptr;
    }

    bridge->device = bridge->sender.GetDX11Device();
    bridge->context = bridge->sender.GetDX11Context();

    // Get ID3D11Device1 interface for OpenSharedResource1 (required for NT handles)
    HRESULT hr = bridge->device->QueryInterface(__uuidof(ID3D11Device1), (void**)&bridge->device1);
    if (FAILED(hr)) {
        // Fallback: device1 will be null, we'll try OpenSharedResource instead
        bridge->device1 = nullptr;
    }

    // Set sender name
    if (!bridge->sender.SetSenderName(name)) {
        if (bridge->device1) bridge->device1->Release();
        bridge->sender.CloseDirectX11();
        delete bridge;
        return nullptr;
    }

    // Set format to BGRA (matches Chromium's compositor output)
    bridge->sender.SetSenderFormat(DXGI_FORMAT_B8G8R8A8_UNORM);

    bridge->initialized = true;
    return bridge;
}

void spout_bridge_destroy(void* handle) {
    if (!handle) return;

    SpoutBridge* bridge = static_cast<SpoutBridge*>(handle);
    bridge->sender.ReleaseSender();
    if (bridge->device1) {
        bridge->device1->Release();
        bridge->device1 = nullptr;
    }
    bridge->sender.CloseDirectX11();
    delete bridge;
}

int32_t spout_bridge_send(void* handle, int64_t shared_handle) {
    if (!handle) return -1;

    SpoutBridge* bridge = static_cast<SpoutBridge*>(handle);
    if (!bridge->initialized || !bridge->device) return -2;

    // Cast the shared handle from Electron's texture
    HANDLE nt_handle = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(shared_handle));
    if (!nt_handle) return -3;

    // Open the shared texture from the handle
    ID3D11Texture2D* shared_texture = nullptr;
    HRESULT hr;

    // Electron 40+ uses NT handles, which require OpenSharedResource1 (ID3D11Device1)
    if (bridge->device1) {
        hr = bridge->device1->OpenSharedResource1(
            nt_handle,
            __uuidof(ID3D11Texture2D),
            reinterpret_cast<void**>(&shared_texture)
        );
    } else {
        // Fallback to legacy DXGI handle method (for older Electron versions)
        hr = bridge->device->OpenSharedResource(
            nt_handle,
            __uuidof(ID3D11Texture2D),
            reinterpret_cast<void**>(&shared_texture)
        );
    }

    if (FAILED(hr) || !shared_texture) {
        return -4;
    }

    // Send the texture via Spout
    bool success = bridge->sender.SendTexture(shared_texture);

    // Release the shared texture reference
    shared_texture->Release();

    return success ? 0 : -5;
}

int32_t spout_bridge_resize(void* handle, uint32_t width, uint32_t height) {
    if (!handle) return -1;

    SpoutBridge* bridge = static_cast<SpoutBridge*>(handle);
    bridge->width = width;
    bridge->height = height;

    // Spout handles resize automatically on next SendTexture
    return 0;
}

// ============================================================
// Receiver
// ============================================================

struct SpoutReceiverBridge {
    spoutDX receiver;
    ID3D11Device* device;
    ID3D11DeviceContext* context;
    ID3D11Texture2D* staging;
    unsigned int width;
    unsigned int height;
    bool connected;
    char senderName[256];
};

void* spout_receiver_create(const char* sender_name) {
    SpoutReceiverBridge* bridge = new SpoutReceiverBridge();
    bridge->device = nullptr;
    bridge->context = nullptr;
    bridge->staging = nullptr;
    bridge->width = 0;
    bridge->height = 0;
    bridge->connected = false;
    memset(bridge->senderName, 0, sizeof(bridge->senderName));

    if (sender_name && sender_name[0]) {
        strncpy(bridge->senderName, sender_name, sizeof(bridge->senderName) - 1);
    }

    // Initialize DirectX 11
    if (!bridge->receiver.OpenDirectX11()) {
        delete bridge;
        return nullptr;
    }

    bridge->device = bridge->receiver.GetDX11Device();
    bridge->context = bridge->receiver.GetDX11Context();

    // Set the sender name to connect to (empty = first available)
    bridge->receiver.SetReceiverName(bridge->senderName);

    return bridge;
}

void spout_receiver_destroy(void* handle) {
    if (!handle) return;

    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    bridge->receiver.ReleaseReceiver();
    if (bridge->staging) {
        bridge->staging->Release();
        bridge->staging = nullptr;
    }
    bridge->receiver.CloseDirectX11();
    delete bridge;
}

int32_t spout_receiver_has_new_frame(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->receiver.IsFrameNew() ? 1 : 0;
}

// Helper: ensure staging texture matches current dimensions.
// Checks actual texture desc (not cached bridge dimensions) to avoid stale size bugs.
static bool ensure_staging(SpoutReceiverBridge* bridge, uint32_t w, uint32_t h) {
    if (bridge->staging) {
        D3D11_TEXTURE2D_DESC existing = {};
        bridge->staging->GetDesc(&existing);
        if (existing.Width == w && existing.Height == h) {
            return true;
        }
        bridge->staging->Release();
        bridge->staging = nullptr;
    }

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = w;
    desc.Height = h;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

    HRESULT hr = bridge->device->CreateTexture2D(&desc, nullptr, &bridge->staging);
    return SUCCEEDED(hr) && bridge->staging;
}

int32_t spout_receiver_receive_rgba(void* handle,
                                     uint8_t* out_buffer, uint32_t buffer_size,
                                     uint32_t* out_width, uint32_t* out_height) {
    if (!handle || !out_buffer || !out_width || !out_height) return -1;

    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);

    // Single ReceiveTexture() call to update connection state and dimensions.
    // Do NOT call ReceiveTexture() twice — it has frame-consume semantics.
    if (!bridge->receiver.ReceiveTexture()) {
        return -1;
    }

    unsigned int w = bridge->receiver.GetSenderWidth();
    unsigned int h = bridge->receiver.GetSenderHeight();
    if (w == 0 || h == 0) return -1;

    bridge->connected = true;
    bridge->width = w;
    bridge->height = h;

    // Must set out dimensions BEFORE the buffer size check —
    // caller uses these to allocate the correct buffer on retry.
    *out_width = w;
    *out_height = h;

    uint32_t requiredSize = w * h * 4;
    if (buffer_size < requiredSize) {
        return -1;
    }

    // Ensure staging texture matches current dimensions
    if (!ensure_staging(bridge, w, h)) {
        return -1;
    }

    // Get spoutDX's internal shared texture via double-pointer API.
    // ReceiveTexture(&pTexture) provides access to the already-received frame.
    ID3D11Texture2D* sharedTexture = nullptr;
    if (!bridge->receiver.ReceiveTexture(&sharedTexture) || !sharedTexture) {
        return -1;
    }

    // Copy shared texture to staging texture (GPU → GPU)
    bridge->context->CopyResource(bridge->staging, sharedTexture);

    // Map staging texture for CPU read (GPU → CPU readback)
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    HRESULT hr = bridge->context->Map(bridge->staging, 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr)) {
        return -1;
    }

    // Copy row by row (mapped pitch may differ from w*4)
    const uint8_t* src = static_cast<const uint8_t*>(mapped.pData);
    uint32_t dstPitch = w * 4;
    for (unsigned int y = 0; y < h; y++) {
        memcpy(out_buffer + y * dstPitch, src + y * mapped.RowPitch, dstPitch);
    }

    bridge->context->Unmap(bridge->staging, 0);
    return 0;
}

int32_t spout_receiver_is_connected(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->receiver.IsConnected() ? 1 : 0;
}

uint32_t spout_receiver_get_width(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->width;
}

uint32_t spout_receiver_get_height(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->height;
}

// ============================================================
// Discovery
// ============================================================

int32_t spout_discovery_get_sender_count(void) {
    spoutDX spout;
    return spout.GetSenderCount();
}

// Get sender name by index. Returns 0 on success, -1 on error.
// out_name must be at least 256 bytes.
int32_t spout_discovery_get_sender_name(int32_t index, char* out_name, uint32_t name_size) {
    if (!out_name || name_size < 256) return -1;

    spoutDX spout;
    char name[256];
    memset(name, 0, sizeof(name));

    if (!spout.GetSender(index, name)) {
        return -1;
    }

    strncpy(out_name, name, name_size - 1);
    out_name[name_size - 1] = '\0';
    return 0;
}

// ============================================================
// Consolidated Discovery
// ============================================================

// Returns a JSON string: [{"name":"..."},{"name":"..."}]
// Uses a single spoutDX instance for all queries (avoids N+1 DX context churn).
// Caller must free the returned string with spout_discovery_free_string().
char* spout_discovery_list_senders(void) {
    spoutDX spout;
    int count = spout.GetSenderCount();

    std::string json = "[";
    bool first = true;
    for (int i = 0; i < count; i++) {
        char name[256];
        memset(name, 0, sizeof(name));
        if (!spout.GetSender(i, name)) continue;

        if (!first) json += ",";
        first = false;
        json += "{\"name\":\"";
        // Escape JSON special characters (including all control chars per JSON spec)
        for (const char* p = name; *p; p++) {
            unsigned char c = static_cast<unsigned char>(*p);
            if (c == '"') {
                json += "\\\"";
            } else if (c == '\\') {
                json += "\\\\";
            } else if (c == '\n') {
                json += "\\n";
            } else if (c == '\r') {
                json += "\\r";
            } else if (c == '\t') {
                json += "\\t";
            } else if (c < 0x20) {
                char buf[8];
                snprintf(buf, sizeof(buf), "\\u%04x", c);
                json += buf;
            } else {
                json += *p;
            }
        }
        json += "\"}";
    }
    json += "]";

    return _strdup(json.c_str());
}

void spout_discovery_free_string(char* str) {
    if (str) free(str);
}

} // extern "C"
