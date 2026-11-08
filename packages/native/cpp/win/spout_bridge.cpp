// spout_bridge.cpp
// C++ bridge for Rust FFI to Spout2 SDK
//
// Sender side uses the spoutDX helper class.
// Receiver side talks to the Spout primitives directly (SpoutSenderNames,
// SpoutFrameCount, SpoutDirectX). This sidesteps spoutDX::ReceiveTexture's
// implicit contract that `*ppTexture` be pre-allocated, which broke the
// zero-copy GPU receive path in our configuration.

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <system_error>
#include <thread>
#include <d3d11_1.h>
#include <d3d11_4.h>  // ID3D11Multithread
#include "SpoutDX.h"
#include "SpoutSenderNames.h"
#include "SpoutFrameCount.h"
#include "SpoutDirectX.h"
#include <mmsystem.h> // timeBeginPeriod / timeEndPeriod (winmm)

#include <vector>

// ============================================================
// Sender preview tap (downscaled CPU readback, best-effort)
// ============================================================
//
// D3D11 has no completion callback, so the readback is polled: the frame sent
// at N is downscaled into a staging ring slot, and the slot is mapped with
// D3D11_MAP_FLAG_DO_NOT_WAIT on a later send (typically N+1) or by
// spout_bridge_poll_preview (the JS bridge calls it from a short timer while a
// slot is pending, so the last frame of a sender that stops sending is still
// delivered). Nothing ever waits on the GPU; a slot that is still in flight
// just stays pending.
//
// Downscale = CopySubresourceRegion into mip 0 of a full-resolution texture
// with a mip chain -> GenerateMips (2x2 box filter per level) -> copy one mip
// level into the staging slot. This avoids a runtime shader compiler
// dependency; the price is that only power-of-two sizes are available, so the
// preview is the smallest mip level that still covers the requested
// (aspect-fitted) bounds and reports its real size.

typedef void (*spout_preview_callback)(void* ctx,
                                       const uint8_t* rgba,
                                       uint32_t width,
                                       uint32_t height);

static constexpr uint32_t kPreviewRingSize = 3;

struct SpoutPreviewSlot {
    ID3D11Texture2D* staging = nullptr;
    bool             pending = false;
    uint64_t         seq = 0; // submission order of the pending copy
};

struct SpoutPreview {
    spout_preview_callback callback = nullptr;
    void*                  callbackCtx = nullptr;
    uint32_t               maxWidth = 0;
    uint32_t               maxHeight = 0;

    // Full-resolution mip-chain texture the source is copied into.
    ID3D11Texture2D*          mipTexture = nullptr;
    ID3D11ShaderResourceView* mipSrv = nullptr;
    uint32_t                  srcWidth = 0;
    uint32_t                  srcHeight = 0;
    DXGI_FORMAT               format = DXGI_FORMAT_UNKNOWN;
    uint32_t                  mipLevels = 0;

    // Selected level and the staging ring sized for it.
    uint32_t         level = 0;
    uint32_t         levelWidth = 0;
    uint32_t         levelHeight = 0;
    SpoutPreviewSlot ring[kPreviewRingSize];
    uint64_t         nextSeq = 0;

    std::vector<uint8_t> scratch; // tightly packed RGBA handed to the callback
    uint64_t             skippedFrames = 0;
    bool                 loggedFailure = false;
};

struct SpoutBridge {
    spoutDX sender;
    ID3D11Device* device;
    ID3D11Device1* device1;  // For OpenSharedResource1 (NT handles)
    ID3D11DeviceContext* context;
    unsigned int width;
    unsigned int height;
    bool initialized;
    SpoutPreview preview;
};

static void log_preview_failure_once(SpoutPreview& preview, const char* what, HRESULT hr) {
    if (preview.loggedFailure) return;
    preview.loggedFailure = true;
    fprintf(stderr, "[SpoutBridge] preview: %s failed (hr=0x%08lx); skipping preview frames\n",
            what, static_cast<unsigned long>(hr));
}

static void release_preview_ring(SpoutPreview& preview) {
    for (uint32_t i = 0; i < kPreviewRingSize; i++) {
        if (preview.ring[i].staging) {
            preview.ring[i].staging->Release();
            preview.ring[i].staging = nullptr;
        }
        preview.ring[i].pending = false;
    }
    preview.levelWidth = 0;
    preview.levelHeight = 0;
}

static void release_preview_resources(SpoutPreview& preview) {
    release_preview_ring(preview);
    if (preview.mipSrv) {
        preview.mipSrv->Release();
        preview.mipSrv = nullptr;
    }
    if (preview.mipTexture) {
        preview.mipTexture->Release();
        preview.mipTexture = nullptr;
    }
    preview.srcWidth = 0;
    preview.srcHeight = 0;
    preview.format = DXGI_FORMAT_UNKNOWN;
    preview.mipLevels = 0;
}

static bool preview_format_supported(DXGI_FORMAT format) {
    return format == DXGI_FORMAT_B8G8R8A8_UNORM || format == DXGI_FORMAT_R8G8B8A8_UNORM;
}

// (Re)create the mip-chain texture + staging ring when the source geometry or
// format changes. All-or-nothing: on failure every preview resource is freed.
static bool ensure_preview_resources(SpoutBridge* bridge, const D3D11_TEXTURE2D_DESC& src);

// Map every pending slot whose copy has completed, oldest first, and deliver
// the newest completed one. Never waits. A slot whose copy is still running
// stops the scan (later submissions cannot have finished before it).
static void poll_preview(SpoutBridge* bridge);

// Queue the downscale + readback of `source` into a free ring slot.
static void encode_preview(SpoutBridge* bridge, ID3D11Texture2D* source);

extern "C" {

// Pure helpers (exported for Rust tests) ------------------------------------

void spout_preview_fit_size(uint32_t src_w,
                            uint32_t src_h,
                            uint32_t max_w,
                            uint32_t max_h,
                            uint32_t* out_w,
                            uint32_t* out_h) {
    if (!out_w || !out_h) return;
    if (src_w == 0 || src_h == 0 || max_w == 0 || max_h == 0) {
        *out_w = 0;
        *out_h = 0;
        return;
    }
    const uint64_t sw = src_w, sh = src_h, mw = max_w, mh = max_h;
    uint64_t w = sw;
    uint64_t h = sh;
    if (sw > mw || sh > mh) {
        if (mw * sh <= mh * sw) {
            w = mw;
            h = (sh * mw + sw / 2) / sw;
        } else {
            h = mh;
            w = (sw * mh + sh / 2) / sh;
        }
    }
    *out_w = static_cast<uint32_t>(w == 0 ? 1 : w);
    *out_h = static_cast<uint32_t>(h == 0 ? 1 : h);
}

// The smallest mip level (largest index < mip_levels) of a src_w x src_h
// texture whose size still covers the aspect-fitted max_w x max_h bounds.
// Writes the level and its size. Level 0 when the bounds are not smaller.
void spout_preview_pick_mip(uint32_t src_w,
                            uint32_t src_h,
                            uint32_t max_w,
                            uint32_t max_h,
                            uint32_t mip_levels,
                            uint32_t* out_level,
                            uint32_t* out_w,
                            uint32_t* out_h) {
    if (!out_level || !out_w || !out_h) return;
    uint32_t fit_w = 0;
    uint32_t fit_h = 0;
    spout_preview_fit_size(src_w, src_h, max_w, max_h, &fit_w, &fit_h);
    uint32_t level = 0;
    if (fit_w > 0 && fit_h > 0) {
        while (level + 1 < mip_levels) {
            const uint32_t next_w = (src_w >> (level + 1)) > 0 ? (src_w >> (level + 1)) : 1;
            const uint32_t next_h = (src_h >> (level + 1)) > 0 ? (src_h >> (level + 1)) : 1;
            if (next_w < fit_w || next_h < fit_h) break;
            level++;
        }
    }
    *out_level = level;
    *out_w = (src_w >> level) > 0 ? (src_w >> level) : 1;
    *out_h = (src_h >> level) > 0 ? (src_h >> level) : 1;
}

} // extern "C"

static bool ensure_preview_resources(SpoutBridge* bridge, const D3D11_TEXTURE2D_DESC& src) {
    SpoutPreview& preview = bridge->preview;
    const bool sameSource = preview.mipTexture && preview.srcWidth == src.Width &&
                            preview.srcHeight == src.Height && preview.format == src.Format;
    if (!sameSource) {
        release_preview_resources(preview);

        D3D11_TEXTURE2D_DESC desc = {};
        desc.Width = src.Width;
        desc.Height = src.Height;
        desc.MipLevels = 0; // full chain
        desc.ArraySize = 1;
        desc.Format = src.Format;
        desc.SampleDesc.Count = 1;
        desc.Usage = D3D11_USAGE_DEFAULT;
        desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
        desc.MiscFlags = D3D11_RESOURCE_MISC_GENERATE_MIPS;
        HRESULT hr = bridge->device->CreateTexture2D(&desc, nullptr, &preview.mipTexture);
        if (FAILED(hr) || !preview.mipTexture) {
            preview.mipTexture = nullptr;
            log_preview_failure_once(preview, "CreateTexture2D(mip chain)", hr);
            return false;
        }
        hr = bridge->device->CreateShaderResourceView(preview.mipTexture, nullptr, &preview.mipSrv);
        if (FAILED(hr) || !preview.mipSrv) {
            preview.mipSrv = nullptr;
            log_preview_failure_once(preview, "CreateShaderResourceView(mip chain)", hr);
            release_preview_resources(preview);
            return false;
        }
        D3D11_TEXTURE2D_DESC created = {};
        preview.mipTexture->GetDesc(&created);
        preview.srcWidth = src.Width;
        preview.srcHeight = src.Height;
        preview.format = src.Format;
        preview.mipLevels = created.MipLevels;
    }

    uint32_t level = 0;
    uint32_t lw = 0;
    uint32_t lh = 0;
    spout_preview_pick_mip(preview.srcWidth, preview.srcHeight, preview.maxWidth,
                           preview.maxHeight, preview.mipLevels, &level, &lw, &lh);
    if (preview.ring[0].staging && preview.level == level && preview.levelWidth == lw &&
        preview.levelHeight == lh) {
        return true;
    }

    release_preview_ring(preview);
    for (uint32_t i = 0; i < kPreviewRingSize; i++) {
        D3D11_TEXTURE2D_DESC desc = {};
        desc.Width = lw;
        desc.Height = lh;
        desc.MipLevels = 1;
        desc.ArraySize = 1;
        desc.Format = preview.format;
        desc.SampleDesc.Count = 1;
        desc.Usage = D3D11_USAGE_STAGING;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        HRESULT hr = bridge->device->CreateTexture2D(&desc, nullptr, &preview.ring[i].staging);
        if (FAILED(hr) || !preview.ring[i].staging) {
            preview.ring[i].staging = nullptr;
            log_preview_failure_once(preview, "CreateTexture2D(staging)", hr);
            release_preview_resources(preview);
            return false;
        }
    }
    preview.level = level;
    preview.levelWidth = lw;
    preview.levelHeight = lh;
    return true;
}

// True for the DXGI formats whose bytes are B, G, R, A in memory.
static bool spout_format_is_bgra(DWORD format) {
    return format == DXGI_FORMAT_B8G8R8A8_UNORM ||
           format == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB ||
           format == DXGI_FORMAT_B8G8R8A8_TYPELESS;
}

// BGRA to RGBA, one row (matches syphon_convert_bgra_to_rgba on macOS).
static void spout_convert_bgra_to_rgba(const uint8_t* src, uint8_t* dst, uint32_t pixel_count) {
    for (uint32_t i = 0; i < pixel_count; i++) {
        dst[i * 4 + 0] = src[i * 4 + 2];
        dst[i * 4 + 1] = src[i * 4 + 1];
        dst[i * 4 + 2] = src[i * 4 + 0];
        dst[i * 4 + 3] = src[i * 4 + 3];
    }
}

// Copy one mapped staging slot into `scratch` as tightly packed RGBA.
static void read_mapped_preview(SpoutPreview& preview, const D3D11_MAPPED_SUBRESOURCE& mapped) {
    const uint32_t w = preview.levelWidth;
    const uint32_t h = preview.levelHeight;
    preview.scratch.resize(static_cast<size_t>(w) * h * 4);
    const bool bgra = spout_format_is_bgra(preview.format);
    for (uint32_t y = 0; y < h; y++) {
        const uint8_t* src = static_cast<const uint8_t*>(mapped.pData) +
                             static_cast<size_t>(y) * mapped.RowPitch;
        uint8_t* dst = preview.scratch.data() + static_cast<size_t>(y) * w * 4;
        if (!bgra) {
            memcpy(dst, src, static_cast<size_t>(w) * 4);
            continue;
        }
        spout_convert_bgra_to_rgba(src, dst, w);
    }
}

static int32_t oldest_pending_slot(const SpoutPreview& preview) {
    int32_t oldest = -1;
    for (uint32_t i = 0; i < kPreviewRingSize; i++) {
        if (!preview.ring[i].pending) continue;
        if (oldest < 0 || preview.ring[i].seq < preview.ring[oldest].seq) {
            oldest = static_cast<int32_t>(i);
        }
    }
    return oldest;
}

static void poll_preview(SpoutBridge* bridge) {
    SpoutPreview& preview = bridge->preview;
    bool haveFrame = false;
    for (;;) {
        const int32_t index = oldest_pending_slot(preview);
        if (index < 0) break;
        SpoutPreviewSlot& slot = preview.ring[index];
        D3D11_MAPPED_SUBRESOURCE mapped = {};
        const HRESULT hr = bridge->context->Map(slot.staging, 0, D3D11_MAP_READ,
                                                D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
        if (hr == DXGI_ERROR_WAS_STILL_DRAWING) break;
        slot.pending = false;
        if (FAILED(hr)) {
            log_preview_failure_once(preview, "Map(staging)", hr);
            continue;
        }
        // Older completed slots are overwritten by newer ones: only the
        // newest finished preview is worth delivering.
        read_mapped_preview(preview, mapped);
        bridge->context->Unmap(slot.staging, 0);
        haveFrame = true;
    }
    if (haveFrame && preview.callback) {
        preview.callback(preview.callbackCtx, preview.scratch.data(), preview.levelWidth,
                         preview.levelHeight);
    }
}

static bool has_pending_preview(const SpoutPreview& preview) {
    return oldest_pending_slot(preview) >= 0;
}

static void encode_preview(SpoutBridge* bridge, ID3D11Texture2D* source) {
    SpoutPreview& preview = bridge->preview;
    D3D11_TEXTURE2D_DESC src = {};
    source->GetDesc(&src);
    if (!preview_format_supported(src.Format) || src.SampleDesc.Count != 1) {
        log_preview_failure_once(preview, "unsupported source format", E_INVALIDARG);
        return;
    }
    if (!ensure_preview_resources(bridge, src)) return;

    int32_t slotIndex = -1;
    for (uint32_t i = 0; i < kPreviewRingSize; i++) {
        if (!preview.ring[i].pending) {
            slotIndex = static_cast<int32_t>(i);
            break;
        }
    }
    if (slotIndex < 0) {
        preview.skippedFrames++;
        return;
    }

    ID3D11DeviceContext* ctx = bridge->context;
    ctx->CopySubresourceRegion(preview.mipTexture, 0, 0, 0, 0, source, 0, nullptr);
    if (preview.mipLevels > 1) ctx->GenerateMips(preview.mipSrv);
    ctx->CopySubresourceRegion(preview.ring[slotIndex].staging, 0, 0, 0, 0, preview.mipTexture,
                               D3D11CalcSubresource(preview.level, 0, preview.mipLevels),
                               nullptr);
    preview.ring[slotIndex].pending = true;
    preview.ring[slotIndex].seq = ++preview.nextSeq;
    // Submit now so the copy is (usually) done by the next send's poll.
    ctx->Flush();
}

extern "C" {

int32_t spout_bridge_set_preview(void* handle,
                                 uint32_t max_width,
                                 uint32_t max_height,
                                 spout_preview_callback cb,
                                 void* ctx) {
    if (!handle) return -1;
    SpoutBridge* bridge = static_cast<SpoutBridge*>(handle);
    if (cb && (max_width == 0 || max_height == 0)) return -1;
    SpoutPreview& preview = bridge->preview;
    preview.callback = cb;
    preview.callbackCtx = cb ? ctx : nullptr;
    preview.loggedFailure = false;
    const bool boundsChanged = preview.maxWidth != max_width || preview.maxHeight != max_height;
    preview.maxWidth = cb ? max_width : 0;
    preview.maxHeight = cb ? max_height : 0;
    if (!cb) {
        // A disabled tap holds no GPU memory; pending readbacks are dropped.
        release_preview_resources(preview);
    } else if (boundsChanged) {
        // New bounds may select another mip level: rebuilt on the next send.
        release_preview_ring(preview);
    }
    return 0;
}

int32_t spout_bridge_poll_preview(void* handle) {
    if (!handle) return -1;
    SpoutBridge* bridge = static_cast<SpoutBridge*>(handle);
    if (!bridge->initialized || !bridge->preview.callback) return 0;
    poll_preview(bridge);
    return has_pending_preview(bridge->preview) ? 1 : 0;
}

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
    // Single-threaded with send/set_preview (all on the JS thread): once this
    // starts no preview callback can run.
    bridge->preview.callback = nullptr;
    bridge->preview.callbackCtx = nullptr;
    release_preview_resources(bridge->preview);
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

    // Deliver previews of earlier frames whose readback has completed. Done
    // first so a failed open below cannot starve the preview stream.
    if (bridge->preview.callback) poll_preview(bridge);

    // Open the shared texture from the handle. Deliberately not cached per
    // handle (unlike the macOS IOSurface wrapper cache): the NT handle belongs
    // to Electron's paint texture and is closed on release(), so its value can
    // be reused for a different resource on a later frame, and a value-keyed
    // cache would then silently publish a stale texture.
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

    // Preview tap: same device, same frame, queued right after the send.
    // Best-effort — never changes the send result.
    if (bridge->preview.callback) encode_preview(bridge, shared_texture);

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
// Receiver — direct spoutSenderNames / SpoutFrameCount / SpoutDirectX
// implementation. Does not use spoutDX to avoid its ReceiveTexture
// pre-allocation contract that broke our zero-copy path.
// ============================================================

// Push receive path (see "Push receive path" below for the design). The
// worker is created by spout_receiver_set_frame_callback and owns its staging
// ring; the bridge only keeps the handle needed to stop + join it.
struct SpoutPushWorker;

struct SpoutReceiverBridge {
    // D3D11 — owned by this bridge (one device per receiver instance).
    ID3D11Device*        device = nullptr;
    ID3D11Device1*       device1 = nullptr;
    ID3D11DeviceContext* context = nullptr;

    // Serializes every use of the Spout primitives, the cached sender
    // texture and the immediate context between the JS-thread poll entry
    // points and the push worker thread. Uncontended unless both are active.
    std::mutex           ioMutex;

    // Spout SDK primitives. spoutSenderNames publishes sender info via a
    // memory-mapped file; spoutFrameCount manages per-sender frame semaphore
    // and named mutex; spoutDirectX wraps OpenSharedResource / CreateDX11device.
    spoutSenderNames* senderNames = nullptr;
    spoutFrameCount*  frameCount = nullptr;
    spoutDirectX*     directX = nullptr;

    // Cached sender metadata. Width/height/connected are atomic because the
    // JS-thread getters read them while the push worker updates them.
    char                      senderName[256] = {};
    std::atomic<unsigned int> senderWidth{0};
    std::atomic<unsigned int> senderHeight{0};
    DWORD                     senderFormat = 0; // DXGI_FORMAT as DWORD (e.g. 87=BGRA)
    HANDLE                    cachedSenderHandle = nullptr;
    ID3D11Texture2D*          senderTexture = nullptr; // opened from cachedSenderHandle
    bool                      frameCountEnabled = false;
    bool                      accessMutexCreated = false;
    std::atomic<bool>         connected{false};

    // Our NT-shared output staging (per-frame DuplicateHandle target).
    ID3D11Texture2D*  ntStaging = nullptr;
    unsigned int      ntStagingWidth = 0;
    unsigned int      ntStagingHeight = 0;
    DWORD             ntStagingFormat = 0;
    HANDLE            cachedNtHandle = nullptr;

    // CPU-mappable staging for the RGBA readback path.
    ID3D11Texture2D*  cpuStaging = nullptr;
    unsigned int      cpuStagingWidth = 0;
    unsigned int      cpuStagingHeight = 0;
    DWORD             cpuStagingFormat = 0;

    // Push path worker, or null while nobody is subscribed. Only touched on
    // the JS thread (set_frame_callback / destroy).
    SpoutPushWorker*  pushWorker = nullptr;
};

// Release any cached reference to the sender's shared texture. Called when
// the sender disappears or publishes a new share handle.
static void release_sender_texture(SpoutReceiverBridge* bridge) {
    if (bridge->senderTexture) {
        bridge->senderTexture->Release();
        bridge->senderTexture = nullptr;
    }
    bridge->cachedSenderHandle = nullptr;
}

// Look up the latest sender info from the Spout sender map and keep our
// cached DXGI share handle / opened texture pointer in sync. Returns true
// if we have a live connection at return time.
static bool refresh_sender(SpoutReceiverBridge* bridge) {
    if (!bridge->senderName[0] || !bridge->device) {
        bridge->connected = false;
        return false;
    }

    unsigned int w = 0;
    unsigned int h = 0;
    HANDLE       shareHandle = nullptr;
    DWORD        format = 0;

    // CheckSender returns false when the named sender is not published (not
    // yet started, or already closed).
    if (!bridge->senderNames->CheckSender(
            bridge->senderName, w, h, shareHandle, format)) {
        release_sender_texture(bridge);
        bridge->connected = false;
        return false;
    }

    // Dimension / format tracking — caller decides whether to signal a 2
    // "dimensions changed" return via staging compare.
    bridge->senderWidth  = w;
    bridge->senderHeight = h;
    bridge->senderFormat = format;

    // Re-open the shared texture only when the handle changed. Sender
    // publishes a fresh DXGI share handle on restart or resize.
    if (!bridge->senderTexture || shareHandle != bridge->cachedSenderHandle) {
        release_sender_texture(bridge);
        if (!shareHandle) {
            bridge->connected = false;
            return false;
        }
        if (!bridge->directX->OpenDX11shareHandle(
                bridge->device, &bridge->senderTexture, shareHandle)) {
            bridge->senderTexture = nullptr;
            bridge->connected = false;
            return false;
        }
        bridge->cachedSenderHandle = shareHandle;
    }

    // Enable the named semaphore + mutex once we know who we're talking to.
    if (!bridge->frameCountEnabled) {
        bridge->frameCount->EnableFrameCount(bridge->senderName);
        bridge->frameCountEnabled = true;
    }
    if (!bridge->accessMutexCreated) {
        bridge->frameCount->CreateAccessMutex(bridge->senderName);
        bridge->accessMutexCreated = true;
    }

    bridge->connected = true;
    return true;
}

// Create one NT-shared texture of (width, height, format) usable as a
// CopyResource destination and as a shader-readable source downstream, plus
// the NT HANDLE minted for it via CreateSharedHandle. On success the caller
// owns one reference on *outTexture and *outHandle. Shared by the poll path's
// single ntStaging and every push-path ring slot. `tag` prefixes log lines.
static bool create_nt_shared_texture(ID3D11Device* device,
                                     unsigned int width,
                                     unsigned int height,
                                     DWORD format,
                                     const char* tag,
                                     ID3D11Texture2D** outTexture,
                                     HANDLE* outHandle) {
    *outTexture = nullptr;
    *outHandle = nullptr;
    if (!device || width == 0 || height == 0) return false;

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = static_cast<DXGI_FORMAT>(format);
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    // NT handle textures must combine NTHANDLE with SHARED or SHARED_KEYEDMUTEX
    // per D3D11 validation. We use the plain SHARED pairing so readers do not
    // have to acquire a keyed mutex on every frame — `CopyResource` inside
    // this file is the only writer, so no mutex sync is required between
    // writer and reader.
    desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE
                   | D3D11_RESOURCE_MISC_SHARED;

    ID3D11Texture2D* texture = nullptr;
    HRESULT hr = device->CreateTexture2D(&desc, nullptr, &texture);
    if (FAILED(hr) || !texture) {
        fprintf(stderr,
                "[SpoutBridge] %s: CreateTexture2D failed hr=0x%08lx w=%u h=%u fmt=%lu\n",
                tag, static_cast<unsigned long>(hr), width, height,
                static_cast<unsigned long>(format));
        return false;
    }

    IDXGIResource1* dxgi = nullptr;
    hr = texture->QueryInterface(
        __uuidof(IDXGIResource1), reinterpret_cast<void**>(&dxgi));
    if (FAILED(hr) || !dxgi) {
        fprintf(stderr,
                "[SpoutBridge] %s: QueryInterface(IDXGIResource1) failed hr=0x%08lx\n",
                tag, static_cast<unsigned long>(hr));
        texture->Release();
        return false;
    }

    HANDLE nt_handle = nullptr;
    hr = dxgi->CreateSharedHandle(
        nullptr,
        DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
        nullptr,
        &nt_handle);
    dxgi->Release();
    if (FAILED(hr) || !nt_handle) {
        fprintf(stderr,
                "[SpoutBridge] %s: CreateSharedHandle failed hr=0x%08lx\n",
                tag, static_cast<unsigned long>(hr));
        texture->Release();
        return false;
    }

    *outTexture = texture;
    *outHandle = nt_handle;
    return true;
}

// Allocate or reallocate the NT-shared staging texture to match dims/format.
// Mints a fresh NT HANDLE via CreateSharedHandle and caches it for
// per-frame DuplicateHandle.
static bool ensure_nt_staging(SpoutReceiverBridge* bridge,
                              unsigned int width,
                              unsigned int height,
                              DWORD format) {
    if (bridge->ntStaging &&
        bridge->ntStagingWidth == width &&
        bridge->ntStagingHeight == height &&
        bridge->ntStagingFormat == format) {
        return true;
    }
    if (bridge->cachedNtHandle) {
        CloseHandle(bridge->cachedNtHandle);
        bridge->cachedNtHandle = nullptr;
    }
    if (bridge->ntStaging) {
        bridge->ntStaging->Release();
        bridge->ntStaging = nullptr;
    }

    if (!create_nt_shared_texture(bridge->device, width, height, format,
                                  "ensure_nt_staging",
                                  &bridge->ntStaging, &bridge->cachedNtHandle)) {
        return false;
    }

    bridge->ntStagingWidth    = width;
    bridge->ntStagingHeight   = height;
    bridge->ntStagingFormat   = format;
    return true;
}

// Allocate or reallocate a CPU-mappable staging texture. Used to bring the
// sender texture into system memory for the RGBA readback path.
static bool ensure_cpu_staging(SpoutReceiverBridge* bridge,
                               unsigned int width,
                               unsigned int height,
                               DWORD format) {
    if (bridge->cpuStaging &&
        bridge->cpuStagingWidth == width &&
        bridge->cpuStagingHeight == height &&
        bridge->cpuStagingFormat == format) {
        return true;
    }
    if (bridge->cpuStaging) {
        bridge->cpuStaging->Release();
        bridge->cpuStaging = nullptr;
    }
    if (!bridge->device || width == 0 || height == 0) return false;

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = static_cast<DXGI_FORMAT>(format);
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    // MiscFlags = 0, BindFlags = 0 (STAGING forbids both)

    HRESULT hr = bridge->device->CreateTexture2D(&desc, nullptr, &bridge->cpuStaging);
    if (FAILED(hr)) {
        bridge->cpuStaging = nullptr;
        return false;
    }
    bridge->cpuStagingWidth  = width;
    bridge->cpuStagingHeight = height;
    bridge->cpuStagingFormat = format;
    return true;
}

// ============================================================
// Push receive path (staging ring + frame callback)
//
// Windows counterpart of the macOS Syphon push path. One worker thread per
// subscribed receiver polls Spout's frame counter about every millisecond,
// copies each new sender frame GPU→GPU into a free slot of a 3-slot ring of
// NT-shared textures, waits (without blocking the JS thread) for that copy to
// complete on the GPU via a D3D11 event query, then hands a freshly
// duplicated NT HANDLE for the slot to the callback. The poll path
// (spout_receiver_receive_shared_texture + its single ntStaging) is untouched.
// ============================================================

// Invoked on the push worker thread. `nt_handle` is a fresh duplicate owned by
// the callee (Electron's importSharedTexture or native_close_shared_handle
// closes it). Must not block for long: the worker delivers nothing else while
// it runs.
typedef void (*spout_frame_callback)(void* ctx,
                                     void* nt_handle,
                                     uint32_t width,
                                     uint32_t height,
                                     uint32_t dxgi_format);

// Pure helper: returns the first index i in [0, n) with held[i] == 0 and
// gpu_busy[i] == 0, else -1.
int32_t spout_ring_pick_slot(const uint8_t* held,
                             const uint8_t* gpu_busy,
                             uint32_t n) {
    if (!held || !gpu_busy) return -1;
    for (uint32_t i = 0; i < n; i++) {
        if (held[i] == 0 && gpu_busy[i] == 0) return static_cast<int32_t>(i);
    }
    return -1;
}

// Number of NT-shared textures in the push staging ring. Three lets one slot
// be written while up to two are still imported downstream.
static constexpr uint32_t kSpoutRingSize = 3;
// Worker wait between Spout frame-counter checks when no new frame arrived.
static constexpr DWORD kPushIdleWaitMs = 1;
// Pacing when the sender's frame counter cannot tell new frames apart
// (Spout "Framecount" registry setting off — the default — or a sender that
// never increments it): GetNewFrame() then always reports a new frame, so
// deliver at the poll path's default 16 ms cadence instead of ~1 kHz. Also
// used while the sender is absent and as the sender re-check interval.
static constexpr DWORD kPushUncountedIntervalMs = 16;
// Upper bound on waiting for one staging copy to complete on the GPU.
static constexpr ULONGLONG kPushGpuWaitTimeoutMs = 1000;
// Spin iterations (SwitchToThread) before the GPU wait falls back to 1 ms
// sleeps, so a typical sub-millisecond copy is picked up without a timer tick.
static constexpr int kPushGpuSpinIterations = 64;

// One ring slot: a receiver-owned NT-shared texture, the NT HANDLE minted for
// it (DuplicateHandle source), and the value of the last duplicate handed out
// for it. `lastHandedOut` is owned by the consumer and never closed here — it
// is only compared against `sharedHandle` to tell whether the consumer still
// holds the slot.
struct SpoutRingSlot {
    ID3D11Texture2D* texture = nullptr;
    HANDLE           sharedHandle = nullptr;
    HANDLE           lastHandedOut = nullptr;
};

struct SpoutPushRing {
    SpoutRingSlot slots[kSpoutRingSize];
    unsigned int  width = 0;
    unsigned int  height = 0;
    DWORD         format = 0;
    // Slot search starts after the most recently delivered slot, so even if
    // the held check under-reports, a slot is reused only after the other two.
    uint32_t      nextStart = 0;
    uint64_t      droppedFrames = 0;
};

struct SpoutPushWorker {
    std::thread          thread;
    HANDLE               stopEvent = nullptr; // manual-reset
    spout_frame_callback callback = nullptr;  // immutable for the worker's life
    void*                callbackCtx = nullptr;
};

// `CompareObjectHandles` (kernelbase, Windows 10 1607+) resolved at runtime so
// the build needs neither a newer SDK header gate nor an extra import library.
typedef BOOL (WINAPI *CompareObjectHandlesFn)(HANDLE, HANDLE);

static CompareObjectHandlesFn resolve_compare_object_handles() {
    HMODULE kernelbase = GetModuleHandleW(L"kernelbase.dll");
    if (!kernelbase) return nullptr;
    return reinterpret_cast<CompareObjectHandlesFn>(
        GetProcAddress(kernelbase, "CompareObjectHandles"));
}

static void release_ring_slot(SpoutRingSlot& slot) {
    // Duplicates already handed to consumers are independent kernel handles
    // and keep the shared resource alive until their owners close them.
    if (slot.sharedHandle) {
        CloseHandle(slot.sharedHandle);
        slot.sharedHandle = nullptr;
    }
    if (slot.texture) {
        slot.texture->Release();
        slot.texture = nullptr;
    }
    slot.lastHandedOut = nullptr;
}

static void release_push_ring(SpoutPushRing& ring) {
    for (uint32_t i = 0; i < kSpoutRingSize; i++) {
        release_ring_slot(ring.slots[i]);
    }
    ring.width = 0;
    ring.height = 0;
    ring.format = 0;
    ring.nextStart = 0;
}

// (Re)allocate every slot when the sender's size/format differs from the
// ring's. All-or-nothing: on failure the ring is left empty. Caller holds
// bridge->ioMutex.
static bool ensure_push_ring(SpoutReceiverBridge* bridge,
                             SpoutPushRing& ring,
                             unsigned int width,
                             unsigned int height,
                             DWORD format) {
    if (ring.slots[0].texture &&
        ring.width == width &&
        ring.height == height &&
        ring.format == format) {
        return true;
    }
    release_push_ring(ring);
    for (uint32_t i = 0; i < kSpoutRingSize; i++) {
        SpoutRingSlot& slot = ring.slots[i];
        if (!create_nt_shared_texture(bridge->device, width, height, format,
                                      "ensure_push_ring",
                                      &slot.texture, &slot.sharedHandle)) {
            release_push_ring(ring);
            return false;
        }
    }
    ring.width = width;
    ring.height = height;
    ring.format = format;
    return true;
}

// Windows analogue of macOS's "retain count back to 1": the slot is held while
// the last duplicate handed out for it still refers to the slot's resource.
// Once the consumer closes it, the handle value is invalid or reused for an
// unrelated object, and CompareObjectHandles returns FALSE. Without
// CompareObjectHandles a handed-out slot counts as held (conservative drop).
//
// Caveat: Electron's importSharedTexture never adopts this handle — it
// DuplicateHandle()s its own copy — and the caller closes ours right after
// the import call returns. So with CompareObjectHandles available this check
// effectively always sees the slot free by the time the next frame is picked:
// it does NOT detect a slot still imported downstream, and the ring degrades
// to round-robin over kSpoutRingSize slots (still strictly better than the
// single staging texture the poll path reuses). Without CompareObjectHandles
// (pre-1607) the "held once handed out" rule never clears, so each slot is
// used once and then every later frame is dropped.
static bool ring_slot_is_held(const SpoutRingSlot& slot, CompareObjectHandlesFn compare) {
    if (!slot.lastHandedOut) return false;
    if (!compare) return true;
    return compare(slot.lastHandedOut, slot.sharedHandle) != FALSE;
}

// Pick a free slot index, searching from ring.nextStart, or -1. gpu_busy is
// always 0 here: the worker waits for each copy before staging the next one,
// so no slot is ever being written at pick time. It is kept for parity with
// the macOS picker, where completion is asynchronous.
static int32_t pick_push_slot(const SpoutPushRing& ring, CompareObjectHandlesFn compare) {
    uint8_t held[kSpoutRingSize];
    uint8_t busy[kSpoutRingSize];
    for (uint32_t i = 0; i < kSpoutRingSize; i++) {
        const SpoutRingSlot& slot = ring.slots[(ring.nextStart + i) % kSpoutRingSize];
        held[i] = ring_slot_is_held(slot, compare) ? 1 : 0;
        busy[i] = 0;
    }
    const int32_t offset = spout_ring_pick_slot(held, busy, kSpoutRingSize);
    if (offset < 0) return -1;
    return static_cast<int32_t>((ring.nextStart + static_cast<uint32_t>(offset)) % kSpoutRingSize);
}

enum class GpuWaitResult { Done, Stopped, Failed };

// Log the first failure and then every 300th, so a removed device does not
// flood stderr at frame rate.
static bool should_log_failure(uint64_t& failures) {
    failures++;
    return failures == 1 || failures % 300 == 0;
}

// Wait for `query` (ended right after the staging copy) to signal, without
// holding ioMutex across the wait. Returns Stopped as soon as the stop event
// is set so unsubscribe/destroy never waits on the GPU.
static GpuWaitResult wait_for_staging_copy(SpoutReceiverBridge* bridge,
                                           ID3D11Query* query,
                                           HANDLE stopEvent,
                                           uint64_t& failures) {
    const ULONGLONG deadline = GetTickCount64() + kPushGpuWaitTimeoutMs;
    for (int i = 0;; i++) {
        HRESULT hr;
        {
            std::lock_guard<std::mutex> lock(bridge->ioMutex);
            hr = bridge->context->GetData(query, nullptr, 0,
                                          D3D11_ASYNC_GETDATA_DONOTFLUSH);
        }
        if (hr == S_OK) return GpuWaitResult::Done;
        if (FAILED(hr)) {
            if (should_log_failure(failures)) {
                fprintf(stderr,
                        "[SpoutBridge] push: GetData(event query) failed hr=0x%08lx "
                        "(%llu failure(s))\n",
                        static_cast<unsigned long>(hr),
                        static_cast<unsigned long long>(failures));
            }
            return GpuWaitResult::Failed;
        }
        if (GetTickCount64() > deadline) {
            if (should_log_failure(failures)) {
                fprintf(stderr,
                        "[SpoutBridge] push: staging copy did not complete within %llu ms "
                        "(%llu failure(s))\n",
                        static_cast<unsigned long long>(kPushGpuWaitTimeoutMs),
                        static_cast<unsigned long long>(failures));
            }
            return GpuWaitResult::Failed;
        }
        const DWORD waitMs = i < kPushGpuSpinIterations ? 0 : 1;
        if (WaitForSingleObject(stopEvent, waitMs) == WAIT_OBJECT_0) {
            return GpuWaitResult::Stopped;
        }
        if (waitMs == 0) SwitchToThread();
    }
}

// What one worker iteration staged, if anything.
struct StagedFrame {
    int32_t      slot = -1;
    unsigned int width = 0;
    unsigned int height = 0;
    DWORD        format = 0;
};

// Per-worker loop state, owned by the worker thread.
struct PushLoopState {
    SpoutPushRing          ring;
    ID3D11Query*           query = nullptr;
    CompareObjectHandlesFn compare = nullptr;
    ULONGLONG              lastSenderCheck = 0;
    uint64_t               gpuWaitFailures = 0;
};

// Under ioMutex: detect a new sender frame, (re)allocate the ring, pick a
// slot and encode the copy + event query. Returns the wait before the next
// iteration; `out.slot >= 0` when a copy was submitted.
static DWORD stage_push_frame(SpoutReceiverBridge* bridge,
                              PushLoopState& state,
                              StagedFrame& out) {
    std::lock_guard<std::mutex> lock(bridge->ioMutex);

    // Re-check the sender (CheckSender opens shared memory) only when
    // disconnected or every kPushUncountedIntervalMs, so the 1 ms idle loop
    // stays cheap; is_connected still notices a vanished sender.
    const ULONGLONG now = GetTickCount64();
    const bool checkDue =
        !bridge->connected || now - state.lastSenderCheck >= kPushUncountedIntervalMs;
    if (checkDue) {
        state.lastSenderCheck = now;
        if (!refresh_sender(bridge)) return kPushUncountedIntervalMs;
    }

    if (!bridge->frameCount->GetNewFrame()) return kPushIdleWaitMs;
    const bool counted = bridge->frameCount->IsFrameCountEnabled() &&
                         bridge->frameCount->GetSenderFrame() > 0;
    const DWORD nextWait = counted ? 0 : kPushUncountedIntervalMs;

    // A new frame may come with a resize / new share handle: refresh (unless
    // just done) so the copy uses the current sender texture and the ring
    // matches it.
    if (!checkDue && !refresh_sender(bridge)) return kPushUncountedIntervalMs;
    const unsigned int width = bridge->senderWidth;
    const unsigned int height = bridge->senderHeight;
    const DWORD format = bridge->senderFormat;

    // A size/format change reallocates the ring and still stages this frame.
    if (!ensure_push_ring(bridge, state.ring, width, height, format)) {
        return kPushUncountedIntervalMs;
    }

    const int32_t slot = pick_push_slot(state.ring, state.compare);
    if (slot < 0) {
        if (should_log_failure(state.ring.droppedFrames)) {
            fprintf(stderr,
                    "[SpoutBridge] push: all %u ring slots still held downstream, "
                    "dropped %llu frame(s) so far\n",
                    kSpoutRingSize,
                    static_cast<unsigned long long>(state.ring.droppedFrames));
        }
        return nextWait == 0 ? kPushIdleWaitMs : nextWait;
    }

    if (!bridge->frameCount->CheckTextureAccess(bridge->senderTexture)) {
        return kPushIdleWaitMs;
    }
    bridge->context->CopyResource(state.ring.slots[slot].texture, bridge->senderTexture);
    bridge->context->End(state.query);
    bridge->context->Flush();
    bridge->frameCount->AllowTextureAccess(bridge->senderTexture);

    out.slot = slot;
    out.width = width;
    out.height = height;
    out.format = format;
    return nextWait;
}

// After the copy completed: mint the consumer's duplicate and invoke the
// callback. Exactly one exit between DuplicateHandle and the callback (stop
// requested), and it closes the duplicate.
static void deliver_push_frame(SpoutPushWorker* worker,
                               PushLoopState& state,
                               const StagedFrame& staged) {
    SpoutRingSlot& slot = state.ring.slots[staged.slot];
    HANDLE duplicate = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), slot.sharedHandle,
                         GetCurrentProcess(), &duplicate,
                         0, FALSE, DUPLICATE_SAME_ACCESS) || !duplicate) {
        fprintf(stderr, "[SpoutBridge] push: DuplicateHandle failed (err=%lu)\n",
                static_cast<unsigned long>(GetLastError()));
        return;
    }
    if (WaitForSingleObject(worker->stopEvent, 0) == WAIT_OBJECT_0) {
        CloseHandle(duplicate);
        return;
    }
    slot.lastHandedOut = duplicate;
    state.ring.nextStart = (static_cast<uint32_t>(staged.slot) + 1) % kSpoutRingSize;
    worker->callback(worker->callbackCtx, duplicate,
                     staged.width, staged.height, static_cast<uint32_t>(staged.format));
}

static void run_push_worker(SpoutReceiverBridge* bridge, SpoutPushWorker* worker) {
    PushLoopState state;
    state.compare = resolve_compare_object_handles();
    if (!state.compare) {
        fprintf(stderr,
                "[SpoutBridge] push: CompareObjectHandles unavailable (needs Windows 10 1607+); "
                "each ring slot is treated as held once handed out\n");
    }

    D3D11_QUERY_DESC queryDesc = {};
    queryDesc.Query = D3D11_QUERY_EVENT;
    HRESULT hr = bridge->device->CreateQuery(&queryDesc, &state.query);
    if (FAILED(hr) || !state.query) {
        fprintf(stderr, "[SpoutBridge] push: CreateQuery(EVENT) failed hr=0x%08lx\n",
                static_cast<unsigned long>(hr));
        return;
    }

    // ~1 ms WaitForSingleObject granularity for the idle wait, scoped to the
    // worker's lifetime.
    const bool raisedTimerResolution = timeBeginPeriod(1) == TIMERR_NOERROR;

    for (;;) {
        StagedFrame staged;
        const DWORD waitMs = stage_push_frame(bridge, state, staged);
        if (staged.slot >= 0) {
            const GpuWaitResult result =
                wait_for_staging_copy(bridge, state.query, worker->stopEvent,
                                      state.gpuWaitFailures);
            if (result == GpuWaitResult::Stopped) break;
            if (result == GpuWaitResult::Done) deliver_push_frame(worker, state, staged);
        }
        if (WaitForSingleObject(worker->stopEvent, waitMs) == WAIT_OBJECT_0) break;
    }

    if (raisedTimerResolution) timeEndPeriod(1);
    state.query->Release();
    release_push_ring(state.ring);
}

// Signal + join the push worker if one is running. After return no callback
// is running or can start. JS thread only.
static void stop_push_worker(SpoutReceiverBridge* bridge) {
    SpoutPushWorker* worker = bridge->pushWorker;
    if (!worker) return;
    bridge->pushWorker = nullptr;
    SetEvent(worker->stopEvent);
    if (worker->thread.joinable()) worker->thread.join();
    CloseHandle(worker->stopEvent);
    delete worker;
}

// Start a push worker delivering to (cb, ctx). JS thread only; any previous
// worker must already be stopped.
static void start_push_worker(SpoutReceiverBridge* bridge,
                              spout_frame_callback cb,
                              void* ctx) {
    std::unique_ptr<SpoutPushWorker> worker(new SpoutPushWorker());
    worker->callback = cb;
    worker->callbackCtx = ctx;
    worker->stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!worker->stopEvent) {
        fprintf(stderr, "[SpoutBridge] push: CreateEvent failed (err=%lu)\n",
                static_cast<unsigned long>(GetLastError()));
        return;
    }
    try {
        SpoutPushWorker* raw = worker.get();
        worker->thread = std::thread([bridge, raw] { run_push_worker(bridge, raw); });
    } catch (const std::system_error& e) {
        fprintf(stderr, "[SpoutBridge] push: worker thread start failed: %s\n", e.what());
        CloseHandle(worker->stopEvent);
        return;
    }
    bridge->pushWorker = worker.release();
}

// Subscribe (cb != NULL) or unsubscribe (cb == NULL) the push path. Always
// stops and joins the current worker first, so once this returns the previous
// callback is not running and will never be called again. The poll path is
// unaffected. JS thread only.
void spout_receiver_set_frame_callback(void* handle, spout_frame_callback cb, void* ctx) {
    if (!handle) return;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    stop_push_worker(bridge);
    if (!cb) return;
    start_push_worker(bridge, cb, ctx);
}

void* spout_receiver_create(const char* sender_name) {
    // Fields are zero-initialized by their default member initializers (the
    // struct now holds std::mutex / std::atomic, so it must not be memset).
    SpoutReceiverBridge* bridge = new SpoutReceiverBridge();

    if (sender_name && sender_name[0]) {
        strncpy(bridge->senderName, sender_name, sizeof(bridge->senderName) - 1);
    }

    bridge->senderNames = new spoutSenderNames();
    bridge->frameCount  = new spoutFrameCount();
    bridge->directX     = new spoutDirectX();

    // Create our own D3D11 device with BGRA_SUPPORT so that NT-shared BGRA
    // staging textures are accepted by CreateTexture2D. spoutDirectX's own
    // CreateDX11device does not pass this flag and CreateTexture2D returns
    // E_INVALIDARG on NT-handle textures.
    const D3D_FEATURE_LEVEL featureLevels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
    };
    D3D_FEATURE_LEVEL obtained = D3D_FEATURE_LEVEL_11_0;
    HRESULT hr = D3D11CreateDevice(
        /*adapter*/ nullptr,
        D3D_DRIVER_TYPE_HARDWARE,
        /*softwareModule*/ nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        featureLevels,
        ARRAYSIZE(featureLevels),
        D3D11_SDK_VERSION,
        &bridge->device,
        &obtained,
        &bridge->context);
    if (FAILED(hr) || !bridge->device) {
        fprintf(stderr,
                "[SpoutBridge] D3D11CreateDevice failed hr=0x%08lx\n",
                static_cast<unsigned long>(hr));
        delete bridge->senderNames;
        delete bridge->frameCount;
        delete bridge->directX;
        delete bridge;
        return nullptr;
    }
    bridge->device->QueryInterface(
        __uuidof(ID3D11Device1), reinterpret_cast<void**>(&bridge->device1));

    // Belt and braces for the push worker: ioMutex already serializes every
    // immediate-context call between the JS thread and the worker, but turn
    // on D3D's own context lock too so a future unguarded call cannot corrupt
    // the context. Non-fatal when unavailable (pre-Creators-Update runtime).
    ID3D11Multithread* multithread = nullptr;
    if (SUCCEEDED(bridge->context->QueryInterface(
            __uuidof(ID3D11Multithread), reinterpret_cast<void**>(&multithread))) &&
        multithread) {
        multithread->SetMultithreadProtected(TRUE);
        multithread->Release();
    }

    return bridge;
}

void spout_receiver_destroy(void* handle) {
    if (!handle) return;

    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);

    // Join the push worker first: after this no callback runs or starts, and
    // the worker has released its ring, query and Spout access. Everything
    // below then runs single-threaded.
    stop_push_worker(bridge);

    // Release cached NT handle before NT staging. Duplicates already handed
    // to Electron are independent kernel handles and stay valid until their
    // owners close them.
    if (bridge->cachedNtHandle) {
        CloseHandle(bridge->cachedNtHandle);
        bridge->cachedNtHandle = nullptr;
    }
    if (bridge->ntStaging)   { bridge->ntStaging->Release();   bridge->ntStaging = nullptr; }
    if (bridge->cpuStaging)  { bridge->cpuStaging->Release();  bridge->cpuStaging = nullptr; }
    release_sender_texture(bridge);

    if (bridge->frameCount) {
        if (bridge->accessMutexCreated) bridge->frameCount->CloseAccessMutex();
        if (bridge->frameCountEnabled)  bridge->frameCount->DisableFrameCount();
    }

    if (bridge->context) { bridge->context->Release(); bridge->context = nullptr; }
    if (bridge->device1) { bridge->device1->Release(); bridge->device1 = nullptr; }
    if (bridge->device)  { bridge->device->Release();  bridge->device  = nullptr; }

    delete bridge->senderNames;
    delete bridge->frameCount;
    delete bridge->directX;
    delete bridge;
}

int32_t spout_receiver_has_new_frame(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    std::lock_guard<std::mutex> lock(bridge->ioMutex);
    return bridge->frameCount->IsFrameNew() ? 1 : 0;
}

// Return codes:
//   0 = frame received successfully
//   1 = no new frame (poll again later)
//   2 = dimensions changed (out_width/out_height have new dims, caller must re-allocate)
//  -1 = not connected / no sender
int32_t spout_receiver_receive_rgba(void* handle,
                                     uint8_t* out_buffer, uint32_t buffer_size,
                                     uint32_t* out_width, uint32_t* out_height) {
    if (!handle || !out_width || !out_height) return -1;

    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    std::lock_guard<std::mutex> lock(bridge->ioMutex);

    if (!refresh_sender(bridge)) {
        return -1;
    }

    // Dimensions or format changed since last CPU staging — report 2 so the
    // caller re-sizes its output buffer.
    const uint32_t requiredSize = bridge->senderWidth * bridge->senderHeight * 4;
    const bool bufferOk = out_buffer && buffer_size >= requiredSize;
    if (bridge->cpuStagingWidth  != bridge->senderWidth  ||
        bridge->cpuStagingHeight != bridge->senderHeight ||
        bridge->cpuStagingFormat != bridge->senderFormat ||
        !bufferOk) {
        if (!ensure_cpu_staging(bridge, bridge->senderWidth, bridge->senderHeight,
                                bridge->senderFormat)) {
            return -1;
        }
        *out_width = bridge->senderWidth;
        *out_height = bridge->senderHeight;
        return 2;
    }

    // Drop the poll if Spout's semaphore says no new frame arrived.
    if (!bridge->frameCount->GetNewFrame()) return 1;

    // Acquire the sender's texture (keyed mutex or named mutex).
    if (!bridge->frameCount->CheckTextureAccess(bridge->senderTexture)) return 1;
    bridge->context->CopyResource(bridge->cpuStaging, bridge->senderTexture);
    bridge->context->Flush();
    bridge->frameCount->AllowTextureAccess(bridge->senderTexture);

    // Map + memcpy into caller buffer. CopyResource → Map is synchronous on
    // an Immediate context because the staging has CPU_ACCESS_READ.
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    HRESULT hr = bridge->context->Map(bridge->cpuStaging, 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr)) return -1;

    // receiveFrame() promises RGBA (and the macOS path converts, see
    // syphon_receiver_receive_rgba). Spout senders are usually BGRA, Electron's
    // compositor output always, so swap R and B for the BGRA formats.
    const uint32_t rowBytes = bridge->senderWidth * 4;
    const uint8_t* src = static_cast<const uint8_t*>(mapped.pData);
    const bool needSwap = spout_format_is_bgra(bridge->senderFormat);
    for (unsigned int row = 0; row < bridge->senderHeight; ++row) {
        const uint8_t* srcRow = src + row * mapped.RowPitch;
        uint8_t* dstRow = out_buffer + row * rowBytes;
        if (needSwap) {
            spout_convert_bgra_to_rgba(srcRow, dstRow, bridge->senderWidth);
        } else {
            memcpy(dstRow, srcRow, rowBytes);
        }
    }
    bridge->context->Unmap(bridge->cpuStaging, 0);

    *out_width = bridge->senderWidth;
    *out_height = bridge->senderHeight;
    return 0;
}

// Receive a frame as a shared NT-handle texture (GPU-to-GPU, zero CPU copy).
// On success, writes a new NT HANDLE into *out_nt_handle that the caller
// owns and must close exactly once via native_close_shared_handle — also
// after passing it to Electron's sharedTexture.importSharedTexture(), which
// DuplicateHandle()s its own copy instead of adopting this one.
//
// Return codes:
//   0 = frame received successfully
//   1 = no new frame (poll again later)
//   2 = dimensions changed, caller should re-poll
//  -1 = not connected / no sender
//  -2 = GPU operation failed (device lost, OOM, missing IDXGIResource1)
int32_t spout_receiver_receive_shared_texture(void* handle,
                                              void** out_nt_handle,
                                              uint32_t* out_width,
                                              uint32_t* out_height,
                                              uint32_t* out_format) {
    if (!handle || !out_nt_handle || !out_width || !out_height || !out_format) {
        return -1;
    }

    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    std::lock_guard<std::mutex> lock(bridge->ioMutex);
    *out_nt_handle = nullptr;

    if (!refresh_sender(bridge)) {
        return -1;
    }

    if (bridge->ntStagingWidth  != bridge->senderWidth  ||
        bridge->ntStagingHeight != bridge->senderHeight ||
        bridge->ntStagingFormat != bridge->senderFormat ||
        !bridge->ntStaging) {
        if (!ensure_nt_staging(bridge, bridge->senderWidth, bridge->senderHeight,
                               bridge->senderFormat)) {
            return -2;
        }
        *out_width  = bridge->senderWidth;
        *out_height = bridge->senderHeight;
        return 2;
    }

    if (!bridge->frameCount->GetNewFrame()) return 1;

    if (!bridge->frameCount->CheckTextureAccess(bridge->senderTexture)) return 1;
    bridge->context->CopyResource(bridge->ntStaging, bridge->senderTexture);
    bridge->context->Flush();
    bridge->frameCount->AllowTextureAccess(bridge->senderTexture);

    HANDLE duplicate = nullptr;
    BOOL ok_dup = DuplicateHandle(
        GetCurrentProcess(),
        bridge->cachedNtHandle,
        GetCurrentProcess(),
        &duplicate,
        0,
        FALSE,
        DUPLICATE_SAME_ACCESS);
    if (!ok_dup || !duplicate) {
        return -2;
    }

    *out_nt_handle = duplicate;
    *out_width  = bridge->senderWidth;
    *out_height = bridge->senderHeight;
    *out_format = bridge->senderFormat;
    return 0;
}

// Close a raw NT HANDLE minted by spout_receiver_receive_shared_texture.
// Call exactly once per handle: after Electron's importSharedTexture returns
// (Electron duplicates its own copy), or instead of importing it.
// Returns 0 on success, -1 if handle is invalid.
int32_t native_close_shared_handle(uintptr_t raw_handle) {
    if (raw_handle == 0) return -1;
    HANDLE nt_handle = reinterpret_cast<HANDLE>(raw_handle);
    if (!CloseHandle(nt_handle)) {
        DWORD err = GetLastError();
        fprintf(stderr,
                "[SpoutBridge] native_close_shared_handle: CloseHandle failed (err=%lu)\n",
                static_cast<unsigned long>(err));
        return -1;
    }
    return 0;
}

int32_t spout_receiver_is_connected(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->connected ? 1 : 0;
}

uint32_t spout_receiver_get_width(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->senderWidth;
}

uint32_t spout_receiver_get_height(void* handle) {
    if (!handle) return 0;
    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);
    return bridge->senderHeight;
}

// ============================================================
// Discovery
// ============================================================

int32_t spout_discovery_get_sender_count(void) {
    spoutSenderNames names;
    return names.GetSenderCount();
}

// Get sender name by index. Returns 0 on success, -1 on error.
// out_name must be at least 256 bytes.
int32_t spout_discovery_get_sender_name(int32_t index, char* out_name, uint32_t name_size) {
    if (!out_name || name_size < 256) return -1;

    spoutSenderNames names;
    char name[256];
    memset(name, 0, sizeof(name));

    if (!names.GetSender(index, name, 256)) {
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
// Caller must free the returned string with spout_discovery_free_string().
char* spout_discovery_list_senders(void) {
    spoutSenderNames names;
    std::set<std::string> senderSet;
    names.GetSenderNames(&senderSet);

    std::string json = "[";
    bool first = true;
    for (const std::string& name : senderSet) {
        if (!first) json += ",";
        first = false;
        json += "{\"name\":\"";
        // Escape JSON special characters (including all control chars per JSON spec)
        for (char ch : name) {
            unsigned char c = static_cast<unsigned char>(ch);
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
                json += ch;
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
