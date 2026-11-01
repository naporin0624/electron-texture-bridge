#import "syphon_bridge.h"
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#import <Syphon/Syphon.h>
#import <Cocoa/Cocoa.h>
#import <atomic>
#import <chrono>
#import <condition_variable>
#import <memory>
#import <mutex>

// Syphon Metal Server のヘッダー（framework 内）
// SyphonMetalServer は Syphon v5+ で利用可能

struct SyphonBridge {
    id<MTLDevice>       device;
    id<MTLCommandQueue> commandQueue;
    SyphonMetalServer*  server;
};

extern "C" {

SyphonBridgeHandle syphon_bridge_create(const char* name) {
    @autoreleasepool {
        auto* bridge = new SyphonBridge();

        // デフォルト Metal デバイス
        bridge->device = MTLCreateSystemDefaultDevice();
        if (!bridge->device) {
            NSLog(@"[SyphonBridge] ERROR: Failed to create Metal device");
            delete bridge;
            return nullptr;
        }
        bridge->commandQueue = [bridge->device newCommandQueue];

        // Syphon Metal Server 作成
        NSString* serverName = [NSString stringWithUTF8String:name];
        bridge->server = [[SyphonMetalServer alloc] initWithName:serverName
                                                          device:bridge->device
                                                         options:nil];

        if (!bridge->server) {
            NSLog(@"[SyphonBridge] ERROR: Failed to create SyphonMetalServer");
            delete bridge;
            return nullptr;
        }

        return static_cast<SyphonBridgeHandle>(bridge);
    }
}

void syphon_bridge_destroy(SyphonBridgeHandle handle) {
    if (!handle) return;
    @autoreleasepool {
        auto* bridge = static_cast<SyphonBridge*>(handle);
        [bridge->server stop];
        bridge->server      = nil;
        bridge->commandQueue = nil;
        bridge->device       = nil;
        delete bridge;
    }
}

int syphon_bridge_send(SyphonBridgeHandle handle,
                       uint32_t surface_id,
                       uint32_t width,
                       uint32_t height) {
    if (!handle) return -1;
    @autoreleasepool {
        auto* bridge = static_cast<SyphonBridge*>(handle);

        // IOSurfaceID → IOSurfaceRef
        IOSurfaceRef surface = IOSurfaceLookup(surface_id);
        if (!surface) return -1;

        // Derive MTLPixelFormat from the IOSurface's actual pixel format
        MTLPixelFormat metalFmt = (MTLPixelFormat)syphon_map_pixel_format(IOSurfaceGetPixelFormat(surface));

        // IOSurface → Metal Texture（GPU zero-copy: 同じ VRAM を参照）
        MTLTextureDescriptor* desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:metalFmt
                                                                                        width:width
                                                                                       height:height
                                                                                    mipmapped:NO];
        desc.usage = MTLTextureUsageShaderRead;
        desc.storageMode = MTLStorageModeShared;

        id<MTLTexture> texture = [bridge->device newTextureWithDescriptor:desc
                                                               iosurface:surface
                                                                   plane:0];
        CFRelease(surface);

        if (!texture) return -1;

        // Syphon にパブリッシュ（GPU→GPU, zero-copy）
        // Publish to Syphon
        id<MTLCommandBuffer> cmdBuf = [bridge->commandQueue commandBuffer];
        [bridge->server publishFrameTexture:texture
                            onCommandBuffer:cmdBuf
                                imageRegion:NSMakeRect(0, 0, width, height)
                                    flipped:YES];
        [cmdBuf addCompletedHandler:^(id<MTLCommandBuffer> completed) {
            if (completed.error) {
                NSLog(@"[SyphonBridge] ERROR: publish (IOSurface id) cmdBuf error: %@", completed.error);
            }
        }];
        [cmdBuf commit];

        return 0;
    }
}

int syphon_bridge_send_surface(SyphonBridgeHandle handle,
                               void* surface_ptr,
                               uint32_t width,
                               uint32_t height) {
    if (!handle || !surface_ptr) return -1;
    @autoreleasepool {
        auto* bridge = static_cast<SyphonBridge*>(handle);

        // Cast to IOSurfaceRef directly (no lookup needed)
        IOSurfaceRef surface = static_cast<IOSurfaceRef>(surface_ptr);

        // Derive MTLPixelFormat from the IOSurface's actual pixel format
        MTLPixelFormat metalFmt = (MTLPixelFormat)syphon_map_pixel_format(IOSurfaceGetPixelFormat(surface));

        // IOSurface → Metal Texture（GPU zero-copy）
        MTLTextureDescriptor* desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:metalFmt
                                                                                        width:width
                                                                                       height:height
                                                                                    mipmapped:NO];
        desc.usage = MTLTextureUsageShaderRead;
        desc.storageMode = MTLStorageModeShared;

        id<MTLTexture> texture = [bridge->device newTextureWithDescriptor:desc
                                                               iosurface:surface
                                                                   plane:0];

        // Note: We don't CFRelease here because we don't own this surface
        // (it's owned by Electron's shared texture system)

        if (!texture) return -1;

        // Publish to Syphon（GPU→GPU, zero-copy）
        // Publish to Syphon
        id<MTLCommandBuffer> cmdBuf = [bridge->commandQueue commandBuffer];
        [bridge->server publishFrameTexture:texture
                            onCommandBuffer:cmdBuf
                                imageRegion:NSMakeRect(0, 0, width, height)
                                    flipped:YES];
        [cmdBuf addCompletedHandler:^(id<MTLCommandBuffer> completed) {
            if (completed.error) {
                NSLog(@"[SyphonBridge] ERROR: publish (IOSurface ptr) cmdBuf error: %@", completed.error);
            }
        }];
        [cmdBuf commit];

        return 0;
    }
}

int syphon_bridge_send_rgba(SyphonBridgeHandle handle,
                            const uint8_t* data,
                            uint32_t width,
                            uint32_t height,
                            uint32_t bytes_per_row) {
    if (!handle || !data) return -1;
    @autoreleasepool {
        auto* bridge = static_cast<SyphonBridge*>(handle);

        // Create IOSurface from RGBA buffer
        NSDictionary* surfaceProps = @{
            (NSString*)kIOSurfaceWidth: @(width),
            (NSString*)kIOSurfaceHeight: @(height),
            (NSString*)kIOSurfaceBytesPerElement: @4,
            (NSString*)kIOSurfaceBytesPerRow: @(bytes_per_row),
            (NSString*)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA),
            (NSString*)kIOSurfaceAllocSize: @(bytes_per_row * height)
        };

        IOSurfaceRef surface = IOSurfaceCreate((__bridge CFDictionaryRef)surfaceProps);
        if (!surface) {
            NSLog(@"[SyphonBridge] ERROR: Failed to create IOSurface");
            return -1;
        }

        // Lock and copy data to IOSurface
        IOSurfaceLock(surface, 0, nullptr);
        void* baseAddr = IOSurfaceGetBaseAddress(surface);
        size_t surfaceBytesPerRow = IOSurfaceGetBytesPerRow(surface);

        // Copy row by row in case of stride mismatch
        const uint8_t* srcRow = data;
        uint8_t* dstRow = static_cast<uint8_t*>(baseAddr);
        size_t copyWidth = (size_t)width * 4;

        for (uint32_t y = 0; y < height; y++) {
            memcpy(dstRow, srcRow, copyWidth);
            srcRow += bytes_per_row;
            dstRow += surfaceBytesPerRow;
        }

        IOSurfaceUnlock(surface, 0, nullptr);

        // Create Metal texture from IOSurface (GPU zero-copy)
        MTLTextureDescriptor* desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                                                        width:width
                                                                                       height:height
                                                                                    mipmapped:NO];
        desc.usage = MTLTextureUsageShaderRead;
        desc.storageMode = MTLStorageModeShared;

        id<MTLTexture> texture = [bridge->device newTextureWithDescriptor:desc
                                                               iosurface:surface
                                                                   plane:0];
        CFRelease(surface);

        if (!texture) {
            NSLog(@"[SyphonBridge] ERROR: Failed to create Metal texture from IOSurface");
            return -1;
        }

        // Publish to Syphon
        id<MTLCommandBuffer> cmdBuf = [bridge->commandQueue commandBuffer];
        [bridge->server publishFrameTexture:texture
                            onCommandBuffer:cmdBuf
                                imageRegion:NSMakeRect(0, 0, width, height)
                                    flipped:YES];
        [cmdBuf addCompletedHandler:^(id<MTLCommandBuffer> completed) {
            if (completed.error) {
                NSLog(@"[SyphonBridge] ERROR: publish (RGBA buffer) cmdBuf error: %@", completed.error);
            }
        }];
        [cmdBuf commit];

        return 0;
    }
}

// ============================================================
// Receiver (SyphonMetalClient)
// ============================================================

// Cached Y-flip render pipeline (library + pipeline for one pixel format).
// The poll path and the push path each own one so they never mutate the same
// cache from two threads (poll runs on the JS thread, push on Syphon's).
struct YFlipPipelineCache {
    id<MTLLibrary>             library = nil;
    id<MTLRenderPipelineState> pipeline = nil;
    MTLPixelFormat             pixelFormat = (MTLPixelFormat)0;
};

// Number of IOSurfaces in the push-path staging ring. Three lets one slot be
// written by the GPU while up to two are still imported downstream.
static constexpr uint32_t kRingSize = 3;

// One push-path staging slot: a receiver-owned IOSurface + the MTLTexture
// wrapping it. Held via shared_ptr so an in-flight completion handler keeps
// the exact slot it staged into alive even if the ring is reallocated (size or
// format change) or the receiver is destroyed before the GPU finishes.
struct RingSlot {
    IOSurfaceRef         surface = nullptr; // one CFRetain owned by the slot
    id<MTLTexture>       texture = nil;
    // CFGetRetainCount(surface) right after allocation — the slot's own
    // retain plus whatever the wrapping MTLTexture holds. A slot is free when
    // its current count is back at this baseline.
    CFIndex              baseRetainCount = 0;
    std::atomic<uint8_t> gpuBusy{0};

    ~RingSlot() {
        texture = nil;
        if (surface) CFRelease(surface);
    }
};

// State shared between the receiver, Syphon's newFrameHandler block and the
// push-path command-buffer completion handlers. Blocks capture it by
// shared_ptr so a handler that races syphon_receiver_destroy only ever touches
// live memory; it sees `shuttingDown` and bails before dereferencing the
// bridge. Every field below `mutex` is guarded by it.
struct PushState {
    std::mutex              mutex;
    std::condition_variable idle;
    bool                    shuttingDown = false;
    syphon_frame_callback   callback = nullptr;
    void*                   callbackCtx = nullptr;
    int                     inFlight = 0; // committed, not yet completed
    std::shared_ptr<RingSlot> ring[kRingSize];
    uint32_t                ringWidth = 0;
    uint32_t                ringHeight = 0;
    MTLPixelFormat          ringPixelFormat = (MTLPixelFormat)0;
    YFlipPipelineCache      yFlip;
    uint64_t                droppedFrames = 0;
    bool                    loggedUnsupportedFormat = false;
};

struct SyphonReceiverBridge {
    id<MTLDevice>       device;
    id<MTLCommandQueue> commandQueue;
    SyphonMetalClient*  client;
    uint32_t            lastWidth;
    uint32_t            lastHeight;
    std::atomic<bool>   hasNewFrameFlag{false};

    // CPU readback path: shared MTLBuffer reused per-frame.
    id<MTLBuffer>       stagingBuffer;
    uint32_t            stagingSize;

    // Zero-copy GPU receive path: per-receiver IOSurface-backed MTLTexture.
    // Mirrors the Windows ntStaging invariant — we hand Electron a retained
    // reference to *our* IOSurface, never to Syphon's pool-recycled texture.
    // Re-created in `ensure_shared_staging` whenever w/h/format changes.
    id<MTLTexture>             sharedStagingTexture;
    IOSurfaceRef               sharedStagingIOSurface;
    uint32_t                   sharedStagingWidth;
    uint32_t                   sharedStagingHeight;
    MTLPixelFormat             sharedStagingPixelFormat;

    // Y-flip render pipeline for the poll path. Compiled lazily the first
    // time a flip-enabled frame arrives (see `ensure_y_flip_pipeline`). Used
    // only when the `flipY` toggle is true; when false the receive path falls
    // back to a straight `MTLBlitCommandEncoder` copy that preserves
    // orientation.
    YFlipPipelineCache         yFlip;

    // Whether the receive path should apply a vertical flip when staging the
    // frame for Electron's `importSharedTexture`. Defaults to true to match
    // the historical behavior shipped in PR #46 — receivers consuming via
    // image-coord APIs (drawImage(VideoFrame), WebGPU importExternalTexture)
    // expect Y-DOWN. Downstream apps that source Syphon frames already in
    // Y-DOWN orientation can opt out via `syphon_receiver_set_flip_y`.
    // Atomic because the push path reads it on Syphon's thread.
    std::atomic<bool>          flipY{true};

    // Push receive path (staging ring + frame callback). See PushState.
    std::shared_ptr<PushState> push;
};

// MSL source for the receive-side Y-flip pass. The flip is encoded directly
// in the UV mapping: vertex 0 (NDC bottom-left, rasterizes to pixel-row H-1)
// maps to UV (0, 0), so the bottom of the destination receives the top of
// the source. The fullscreen triangle covers the framebuffer with NDC
// (-1,-1), (3,-1), (-1,3) — the rasterizer clips beyond NDC ±1.
static NSString* const kYFlipShaderSource =
    @"#include <metal_stdlib>\n"
    @"using namespace metal;\n"
    @"struct VertexOut {\n"
    @"    float4 position [[position]];\n"
    @"    float2 uv;\n"
    @"};\n"
    @"vertex VertexOut texture_bridge_y_flip_vertex(uint vid [[vertex_id]]) {\n"
    @"    float2 positions[3] = { float2(-1.0, -1.0), float2( 3.0, -1.0), float2(-1.0,  3.0) };\n"
    @"    float2 uvs[3]       = { float2( 0.0,  0.0), float2( 2.0,  0.0), float2( 0.0,  2.0) };\n"
    @"    VertexOut out;\n"
    @"    out.position = float4(positions[vid], 0.0, 1.0);\n"
    @"    out.uv = uvs[vid];\n"
    @"    return out;\n"
    @"}\n"
    @"fragment float4 texture_bridge_y_flip_fragment(VertexOut in [[stage_in]],\n"
    @"                                                texture2d<float> src [[texture(0)]]) {\n"
    @"    constexpr sampler s(coord::normalized, address::clamp_to_edge, filter::nearest);\n"
    @"    return src.sample(s, in.uv);\n"
    @"}\n";

// Compile + cache a render pipeline that draws a Y-flipped fullscreen triangle
// into a render target of the given pixel format. Idempotent: returns true
// without rebuilding when the cached pipeline already matches `fmt`.
static bool ensure_y_flip_pipeline(id<MTLDevice> device,
                                   YFlipPipelineCache& cache,
                                   MTLPixelFormat fmt) {
    if (cache.pipeline && cache.pixelFormat == fmt) {
        return true;
    }

    if (!cache.library) {
        NSError* err = nil;
        cache.library = [device newLibraryWithSource:kYFlipShaderSource
                                             options:nil
                                               error:&err];
        if (!cache.library) {
            NSLog(@"[SyphonReceiver] ensure_y_flip_pipeline: shader compile failed: %@", err);
            return false;
        }
    }

    id<MTLFunction> vfn = [cache.library newFunctionWithName:@"texture_bridge_y_flip_vertex"];
    id<MTLFunction> ffn = [cache.library newFunctionWithName:@"texture_bridge_y_flip_fragment"];
    if (!vfn || !ffn) {
        NSLog(@"[SyphonReceiver] ensure_y_flip_pipeline: missing shader functions");
        return false;
    }

    MTLRenderPipelineDescriptor* desc = [[MTLRenderPipelineDescriptor alloc] init];
    desc.vertexFunction = vfn;
    desc.fragmentFunction = ffn;
    desc.colorAttachments[0].pixelFormat = fmt;

    NSError* err = nil;
    id<MTLRenderPipelineState> pipeline =
        [device newRenderPipelineStateWithDescriptor:desc error:&err];
    if (!pipeline) {
        NSLog(@"[SyphonReceiver] ensure_y_flip_pipeline: pipeline creation failed (fmt=%lu): %@",
              (unsigned long)fmt, err);
        return false;
    }

    cache.pipeline = pipeline;
    cache.pixelFormat = fmt;
    return true;
}

// Encode the GPU→GPU staging pass from Syphon's vended texture into a
// receiver-owned texture. Two paths, selected by `flipY`:
//  - flipY=true:  fullscreen render pass with Y-flip (consumer expects Y-DOWN
//    image-coord layout, upstream Syphon source publishes Y-UP).
//  - flipY=false: straight MTLBlitCommandEncoder copy preserving orientation.
// Returns false (nothing encoded) when the flip pipeline cannot be built.
static bool encode_stage_pass(id<MTLCommandBuffer> cmdBuf,
                              id<MTLTexture> src,
                              id<MTLTexture> dst,
                              bool flipY,
                              id<MTLDevice> device,
                              YFlipPipelineCache& cache) {
    if (flipY) {
        if (!ensure_y_flip_pipeline(device, cache, src.pixelFormat)) {
            return false;
        }

        MTLRenderPassDescriptor* passDesc = [MTLRenderPassDescriptor renderPassDescriptor];
        passDesc.colorAttachments[0].texture = dst;
        passDesc.colorAttachments[0].loadAction = MTLLoadActionDontCare;
        passDesc.colorAttachments[0].storeAction = MTLStoreActionStore;

        id<MTLRenderCommandEncoder> enc =
            [cmdBuf renderCommandEncoderWithDescriptor:passDesc];
        [enc setRenderPipelineState:cache.pipeline];
        [enc setFragmentTexture:src atIndex:0];
        [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
        [enc endEncoding];
        return true;
    }

    id<MTLBlitCommandEncoder> blit = [cmdBuf blitCommandEncoder];
    [blit copyFromTexture:src
              sourceSlice:0
              sourceLevel:0
             sourceOrigin:MTLOriginMake(0, 0, 0)
               sourceSize:MTLSizeMake(src.width, src.height, 1)
                toTexture:dst
         destinationSlice:0
         destinationLevel:0
        destinationOrigin:MTLOriginMake(0, 0, 0)];
    [blit endEncoding];
    return true;
}

// IOSurface OSType FourCC literals. Spelled out so the file remains readable
// when grep'd for the Metal pixel format constants alongside.
//   'BGRA' = kCVPixelFormatType_32BGRA
//   'RGBA' = kCVPixelFormatType_32RGBA
//   'RGhA' = kCVPixelFormatType_64RGBAHalf (RGBA half-float, 16 bits per channel)
static constexpr uint32_t kOSTypeBGRA = 'BGRA';
static constexpr uint32_t kOSTypeRGBA = 'RGBA';
static constexpr uint32_t kOSTypeRGBAHalf = 'RGhA';

// Map a Metal pixel format to the small integer code the Rust wrapper decodes
// into a Electron-compatible pixel-format string. Returns -1 for formats we do
// not yet support so the caller can surface a clear error rather than guess.
static int32_t metal_pixel_format_to_code(MTLPixelFormat fmt) {
    switch (fmt) {
        case MTLPixelFormatBGRA8Unorm:  return 0;
        case MTLPixelFormatRGBA8Unorm:  return 1;
        case MTLPixelFormatRGBA16Float: return 2;
        default: return -1;
    }
}

// Map a Metal pixel format to the IOSurface OSType used when we allocate the
// backing IOSurface for the staging MTLTexture. Returns 0 for unsupported.
static uint32_t metal_pixel_format_to_iosurface_ostype(MTLPixelFormat fmt) {
    switch (fmt) {
        case MTLPixelFormatBGRA8Unorm:  return kOSTypeBGRA;
        case MTLPixelFormatRGBA8Unorm:  return kOSTypeRGBA;
        case MTLPixelFormatRGBA16Float: return kOSTypeRGBAHalf;
        default: return 0;
    }
}

// Bytes-per-element for the Metal formats we support. Used when sizing the
// IOSurface row stride.
static uint32_t metal_pixel_format_bytes_per_element(MTLPixelFormat fmt) {
    switch (fmt) {
        case MTLPixelFormatBGRA8Unorm:
        case MTLPixelFormatRGBA8Unorm:
            return 4;
        case MTLPixelFormatRGBA16Float:
            return 8;
        default:
            return 0;
    }
}

static bool allocate_staging_surface(id<MTLDevice> device,
                                     uint32_t width,
                                     uint32_t height,
                                     MTLPixelFormat pixelFormat,
                                     IOSurfaceRef* outSurface,
                                     id<MTLTexture> __strong* outTexture);

// Allocate or reallocate the per-receiver shared staging IOSurface + MTLTexture
// to match (width, height, pixelFormat). Idempotent: returns true without
// touching anything when the cached staging already matches. Returns false on
// allocation failure (out of memory, unsupported format, etc.).
//
// On success, bridge->sharedStagingIOSurface holds a single CFRetain owned by
// the bridge. Per-frame retains for callers are minted on top of that, and
// CFReleased when the imported-texture release fires (or when the unconsumed
// path calls native_close_shared_iosurface).
static bool ensure_shared_staging(SyphonReceiverBridge* bridge,
                                  uint32_t width,
                                  uint32_t height,
                                  MTLPixelFormat pixelFormat) {
    if (bridge->sharedStagingTexture &&
        bridge->sharedStagingIOSurface &&
        bridge->sharedStagingWidth == width &&
        bridge->sharedStagingHeight == height &&
        bridge->sharedStagingPixelFormat == pixelFormat) {
        return true;
    }

    if (bridge->sharedStagingTexture) {
        bridge->sharedStagingTexture = nil;
    }
    if (bridge->sharedStagingIOSurface) {
        CFRelease(bridge->sharedStagingIOSurface);
        bridge->sharedStagingIOSurface = nullptr;
    }
    bridge->sharedStagingWidth = 0;
    bridge->sharedStagingHeight = 0;
    bridge->sharedStagingPixelFormat = (MTLPixelFormat)0;

    if (!bridge->device) return false;

    IOSurfaceRef surface = nullptr;
    id<MTLTexture> texture = nil;
    if (!allocate_staging_surface(bridge->device, width, height, pixelFormat,
                                  &surface, &texture)) {
        return false;
    }

    bridge->sharedStagingIOSurface = surface; // bridge owns one retain
    bridge->sharedStagingTexture = texture;
    bridge->sharedStagingWidth = width;
    bridge->sharedStagingHeight = height;
    bridge->sharedStagingPixelFormat = pixelFormat;
    return true;
}

// Allocate one IOSurface + IOSurface-backed MTLTexture of (width, height,
// pixelFormat) usable as a staging destination (render target / blit dst) and
// as a shader-readable source downstream. On success *outSurface holds one
// CFRetain owned by the caller. Shared by the poll path's single staging
// surface and every push-path ring slot.
static bool allocate_staging_surface(id<MTLDevice> device,
                                     uint32_t width,
                                     uint32_t height,
                                     MTLPixelFormat pixelFormat,
                                     IOSurfaceRef* outSurface,
                                     id<MTLTexture> __strong* outTexture) {
    if (!device || width == 0 || height == 0) return false;

    const uint32_t bytesPerElement = metal_pixel_format_bytes_per_element(pixelFormat);
    const uint32_t osType = metal_pixel_format_to_iosurface_ostype(pixelFormat);
    if (bytesPerElement == 0 || osType == 0) {
        NSLog(@"[SyphonReceiver] allocate_staging_surface: unsupported pixel format %lu",
              (unsigned long)pixelFormat);
        return false;
    }

    const size_t bytesPerRow = (size_t)width * (size_t)bytesPerElement;
    NSDictionary* surfaceProps = @{
        (NSString*)kIOSurfaceWidth: @(width),
        (NSString*)kIOSurfaceHeight: @(height),
        (NSString*)kIOSurfaceBytesPerElement: @(bytesPerElement),
        (NSString*)kIOSurfaceBytesPerRow: @(bytesPerRow),
        (NSString*)kIOSurfacePixelFormat: @(osType),
        (NSString*)kIOSurfaceAllocSize: @(bytesPerRow * (size_t)height),
    };

    IOSurfaceRef surface = IOSurfaceCreate((__bridge CFDictionaryRef)surfaceProps);
    if (!surface) {
        NSLog(@"[SyphonReceiver] allocate_staging_surface: IOSurfaceCreate failed (w=%u h=%u fmt=%lu)",
              width, height, (unsigned long)pixelFormat);
        return false;
    }

    MTLTextureDescriptor* desc =
        [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:pixelFormat
                                                           width:width
                                                          height:height
                                                       mipmapped:NO];
    // Both reads (e.g. WebGPU importExternalTexture downstream) and writes
    // (our blit destination) need to be allowed.
    desc.usage = MTLTextureUsageShaderRead | MTLTextureUsageRenderTarget;
    desc.storageMode = MTLStorageModeShared;

    id<MTLTexture> texture = [device newTextureWithDescriptor:desc
                                                    iosurface:surface
                                                        plane:0];
    if (!texture) {
        NSLog(@"[SyphonReceiver] allocate_staging_surface: newTextureWithDescriptor:iosurface: failed");
        CFRelease(surface);
        return false;
    }

    *outSurface = surface;
    *outTexture = texture;
    return true;
}

// ============================================================
// Push receive path (staging ring + frame callback)
// ============================================================

// (Re)allocate every ring slot when the incoming frame's size/format differs
// from the ring's. Old slots are only dropped from the ring: an in-flight
// completion handler keeps its own shared_ptr, and surfaces already handed to
// consumers carry their own retains. Caller holds push.mutex.
static bool ensure_push_ring(id<MTLDevice> device,
                             PushState& push,
                             uint32_t width,
                             uint32_t height,
                             MTLPixelFormat pixelFormat) {
    if (push.ring[0] &&
        push.ringWidth == width &&
        push.ringHeight == height &&
        push.ringPixelFormat == pixelFormat) {
        return true;
    }

    std::shared_ptr<RingSlot> fresh[kRingSize];
    for (uint32_t i = 0; i < kRingSize; i++) {
        auto slot = std::make_shared<RingSlot>();
        IOSurfaceRef surface = nullptr;
        id<MTLTexture> texture = nil;
        if (!allocate_staging_surface(device, width, height, pixelFormat, &surface, &texture)) {
            return false;
        }
        slot->surface = surface;
        slot->texture = texture;
        slot->baseRetainCount = CFGetRetainCount(surface);
        fresh[i] = slot;
    }

    for (uint32_t i = 0; i < kRingSize; i++) {
        push.ring[i] = fresh[i];
    }
    push.ringWidth = width;
    push.ringHeight = height;
    push.ringPixelFormat = pixelFormat;
    return true;
}

// Return a slot nobody but the bridge holds and the GPU is not writing, or
// nullptr when every slot is still imported downstream. Retain counts are
// normalized against each slot's allocation baseline so "only the bridge
// holds it" is 1 for syphon_ring_pick_slot. Caller holds push.mutex.
static std::shared_ptr<RingSlot> pick_push_slot(PushState& push) {
    uint32_t counts[kRingSize];
    uint8_t busy[kRingSize];
    for (uint32_t i = 0; i < kRingSize; i++) {
        const RingSlot& slot = *push.ring[i];
        const CFIndex extra = CFGetRetainCount(slot.surface) - slot.baseRetainCount;
        counts[i] = extra < 0 ? 1u : (uint32_t)(extra + 1);
        // IOSurfaceIsInUse: conservative guard for consumers invisible to
        // CFGetRetainCount (e.g. Electron's GPU process still sampling the
        // surface via its mach-port import after the main-process retain is
        // gone). Folded into the busy bit so syphon_ring_pick_slot stays pure.
        const bool inUse = IOSurfaceIsInUse(slot.surface);
        busy[i] = (slot.gpuBusy.load(std::memory_order_acquire) || inUse) ? 1 : 0;
    }
    const int32_t idx = syphon_ring_pick_slot(counts, busy, kRingSize);
    if (idx < 0) return nullptr;
    return push.ring[idx];
}

// Runs on a Metal completion thread. Hands the staged surface to the
// subscriber (minting the callee-owned retain) unless the command buffer
// failed, the receiver is shutting down, or nobody is subscribed. Everything
// happens under push.mutex so the Syphon thread can never pick this slot
// between "GPU done" and "retain minted", and so destroy observes inFlight
// reaching zero only after the callback has returned.
static void complete_push_frame(PushState& push,
                                RingSlot& slot,
                                NSError* error,
                                uint32_t width,
                                uint32_t height,
                                uint32_t fmtCode) {
    std::lock_guard<std::mutex> lock(push.mutex);
    if (error) {
        NSLog(@"[SyphonReceiver] push stage command buffer failed: %@", error);
    } else if (!push.shuttingDown && push.callback) {
        CFRetain(slot.surface);
        push.callback(push.callbackCtx, (void*)slot.surface, width, height, fmtCode);
    }
    slot.gpuBusy.store(0, std::memory_order_release);
    push.inFlight--;
    push.idle.notify_all();
}

// Runs on Syphon's new-frame thread with push->mutex held and a subscriber
// set. Stages the newest Syphon frame into a free ring slot and commits
// without waiting; delivery happens in complete_push_frame.
static void stage_push_frame(SyphonReceiverBridge* bridge,
                             const std::shared_ptr<PushState>& push,
                             SyphonMetalClient* client) {
    @autoreleasepool {
        id<MTLTexture> src = [client newFrameImage];
        if (!src) return;

        const uint32_t w = (uint32_t)src.width;
        const uint32_t h = (uint32_t)src.height;
        const MTLPixelFormat fmt = src.pixelFormat;
        const int32_t fmtCode = metal_pixel_format_to_code(fmt);
        if (fmtCode < 0) {
            // Never lie about the layout to importSharedTexture. Logged once
            // per receiver (the poll path surfaces this as return code -3).
            if (!push->loggedUnsupportedFormat) {
                push->loggedUnsupportedFormat = true;
                NSLog(@"[SyphonReceiver] push: dropping frames with unsupported pixel format %lu",
                      (unsigned long)fmt);
            }
            return;
        }

        if (!ensure_push_ring(bridge->device, *push, w, h, fmt)) return;

        std::shared_ptr<RingSlot> slot = pick_push_slot(*push);
        if (!slot) {
            push->droppedFrames++;
            if (push->droppedFrames == 1 || push->droppedFrames % 300 == 0) {
                NSLog(@"[SyphonReceiver] push: all %u ring slots still held downstream, "
                      @"dropped %llu frame(s) so far",
                      kRingSize, (unsigned long long)push->droppedFrames);
            }
            return;
        }

        id<MTLCommandBuffer> cmdBuf = [bridge->commandQueue commandBuffer];
        if (!encode_stage_pass(cmdBuf, src, slot->texture,
                               bridge->flipY.load(std::memory_order_relaxed),
                               bridge->device, push->yFlip)) {
            return;
        }

        slot->gpuBusy.store(1, std::memory_order_release);
        push->inFlight++;
        std::shared_ptr<PushState> state = push;
        [cmdBuf addCompletedHandler:^(id<MTLCommandBuffer> done) {
            complete_push_frame(*state, *slot, done.error, w, h, (uint32_t)fmtCode);
        }];
        [cmdBuf commit];
    }
}

SyphonReceiverHandle syphon_receiver_create(const char* server_uuid,
                                             const char* server_name,
                                             const char* app_name) {
    @autoreleasepool {
        // Find the server in the directory
        SyphonServerDirectory* dir = [SyphonServerDirectory sharedDirectory];
        NSArray* servers = dir.servers;

        NSDictionary* serverDesc = nil;

        if (server_uuid) {
            NSString* uuid = [NSString stringWithUTF8String:server_uuid];
            for (NSDictionary* desc in servers) {
                if ([desc[SyphonServerDescriptionUUIDKey] isEqualToString:uuid]) {
                    serverDesc = desc;
                    break;
                }
            }
        } else {
            NSString* name = server_name ? [NSString stringWithUTF8String:server_name] : nil;
            NSString* app  = app_name ? [NSString stringWithUTF8String:app_name] : nil;

            for (NSDictionary* desc in servers) {
                BOOL nameMatch = !name || [desc[SyphonServerDescriptionNameKey] isEqualToString:name];
                BOOL appMatch  = !app  || [desc[SyphonServerDescriptionAppNameKey] isEqualToString:app];
                if (nameMatch && appMatch) {
                    serverDesc = desc;
                    break;
                }
            }
        }

        if (!serverDesc) {
            NSLog(@"[SyphonReceiver] ERROR: No matching server found");
            return nullptr;
        }

        auto* bridge = new SyphonReceiverBridge();
        bridge->lastWidth = 0;
        bridge->lastHeight = 0;
        bridge->stagingBuffer = nil;
        bridge->stagingSize = 0;
        bridge->sharedStagingTexture = nil;
        bridge->sharedStagingIOSurface = nullptr;
        bridge->sharedStagingWidth = 0;
        bridge->sharedStagingHeight = 0;
        bridge->sharedStagingPixelFormat = (MTLPixelFormat)0;
        bridge->flipY.store(true);
        bridge->push = std::make_shared<PushState>();

        bridge->device = MTLCreateSystemDefaultDevice();
        if (!bridge->device) {
            NSLog(@"[SyphonReceiver] ERROR: Failed to create Metal device");
            delete bridge;
            return nullptr;
        }

        bridge->commandQueue = [bridge->device newCommandQueue];

        // The newFrameHandler block runs on Syphon's background thread. It
        // captures the shared PushState so a handler racing
        // syphon_receiver_destroy only touches live memory: destroy flips
        // `shuttingDown` under push->mutex, and the handler checks it under
        // the same mutex before touching the bridge.
        auto* bridgePtr = bridge;
        std::shared_ptr<PushState> push = bridge->push;
        bridge->client = [[SyphonMetalClient alloc] initWithServerDescription:serverDesc
                                                                       device:bridge->device
                                                                      options:nil
                                                              newFrameHandler:^(SyphonMetalClient* client) {
            std::lock_guard<std::mutex> lock(push->mutex);
            if (push->shuttingDown) return;
            // Poll path: unchanged new-frame flag.
            bridgePtr->hasNewFrameFlag.store(true, std::memory_order_release);
            if (!push->callback) return;
            stage_push_frame(bridgePtr, push, client);
        }];

        if (!bridge->client) {
            NSLog(@"[SyphonReceiver] ERROR: Failed to create SyphonMetalClient");
            delete bridge;
            return nullptr;
        }

        return static_cast<SyphonReceiverHandle>(bridge);
    }
}

void syphon_receiver_destroy(SyphonReceiverHandle handle) {
    if (!handle) return;
    @autoreleasepool {
        auto* bridge = static_cast<SyphonReceiverBridge*>(handle);
        std::shared_ptr<PushState> push = bridge->push;

        // 1. No new staging and no more callbacks from here on. A Syphon
        //    handler or completion handler currently holding the mutex
        //    finishes first; later ones observe shuttingDown.
        {
            std::lock_guard<std::mutex> lock(push->mutex);
            push->shuttingDown = true;
            push->callback = nullptr;
            push->callbackCtx = nullptr;
        }

        [bridge->client stop];
        bridge->client        = nil;
        bridge->stagingBuffer = nil;

        // 2. Wait for in-flight push command buffers so the ring is not
        //    released under the GPU. Bounded so a wedged GPU cannot hang the
        //    JS thread forever; completion handlers only touch the
        //    shared_ptr-owned PushState/RingSlot, never the bridge, so a
        //    timeout is still memory-safe.
        {
            std::unique_lock<std::mutex> lock(push->mutex);
            const bool drained = push->idle.wait_for(
                lock, std::chrono::seconds(2), [&push] { return push->inFlight == 0; });
            if (!drained) {
                NSLog(@"[SyphonReceiver] destroy: %d push command buffer(s) still in flight after 2s",
                      push->inFlight);
            }
            // One CFRelease per slot happens in ~RingSlot once the last
            // shared_ptr (ring or in-flight handler) goes away. Per-frame
            // retains held by consumers stay valid.
            for (uint32_t i = 0; i < kRingSize; i++) {
                push->ring[i].reset();
            }
        }
        bridge->push.reset();

        // Release the per-receiver shared staging IOSurface + texture. Any
        // per-frame retains we minted on top of `sharedStagingIOSurface` are
        // independent — they outlive this destroy call and stay valid until
        // their consumer (Electron's imported texture, or
        // native_close_shared_iosurface) releases them.
        bridge->sharedStagingTexture = nil;
        if (bridge->sharedStagingIOSurface) {
            CFRelease(bridge->sharedStagingIOSurface);
            bridge->sharedStagingIOSurface = nullptr;
        }
        bridge->yFlip = YFlipPipelineCache{};

        bridge->commandQueue  = nil;
        bridge->device        = nil;
        delete bridge;
    }
}

int syphon_receiver_has_new_frame(SyphonReceiverHandle handle) {
    if (!handle) return 0;
    auto* bridge = static_cast<SyphonReceiverBridge*>(handle);
    return bridge->hasNewFrameFlag.load(std::memory_order_acquire) ? 1 : 0;
}

int syphon_receiver_receive_rgba(SyphonReceiverHandle handle,
                                  uint8_t* out_buffer, uint32_t buffer_size,
                                  uint32_t* out_width, uint32_t* out_height) {
    if (!handle || !out_buffer || !out_width || !out_height) return -1;

    auto* bridge = static_cast<SyphonReceiverBridge*>(handle);

    // Peek at the new-frame flag without consuming it. The IOSurface zero-copy
    // path (syphon_receiver_receive_shared_iosurface) is the sole consumer —
    // having both paths exchange would race when a future debug toggle drives
    // both at once. See plan
    // docs/superpowers/plans/2026-04-22-mac-metal-shared-texture-receiver.md.
    // [bridge->client newFrameImage] is documented as thread-safe and always
    // returns the latest frame, so a load() here is sufficient.
    if (!bridge->hasNewFrameFlag.load(std::memory_order_acquire)) {
        *out_width = bridge->lastWidth;
        *out_height = bridge->lastHeight;
        return 1; // no new frame
    }

    @autoreleasepool {
        id<MTLTexture> texture = [bridge->client newFrameImage];
        if (!texture) return -1;

        uint32_t w = (uint32_t)texture.width;
        uint32_t h = (uint32_t)texture.height;
        uint32_t bytesPerRow = w * 4;
        uint32_t requiredSize = bytesPerRow * h;

        // Always update cached dimensions so the next poll allocates correctly.
        *out_width = w;
        *out_height = h;
        bridge->lastWidth = w;
        bridge->lastHeight = h;

        if (buffer_size < requiredSize) {
            return 2; // Buffer too small — dimensions updated for next call
        }

        // Reuse staging buffer — only reallocate when frame size changes.
        if (bridge->stagingBuffer == nil || bridge->stagingSize < requiredSize) {
            bridge->stagingBuffer = [bridge->device newBufferWithLength:requiredSize
                                                                options:MTLResourceStorageModeShared];
            bridge->stagingSize = requiredSize;
        }

        // GPU readback: blit texture contents to the staging buffer
        id<MTLCommandBuffer> cmdBuf = [bridge->commandQueue commandBuffer];
        id<MTLBlitCommandEncoder> blit = [cmdBuf blitCommandEncoder];
        [blit copyFromTexture:texture
                  sourceSlice:0
                  sourceLevel:0
                 sourceOrigin:MTLOriginMake(0, 0, 0)
                   sourceSize:MTLSizeMake(w, h, 1)
                     toBuffer:bridge->stagingBuffer
            destinationOffset:0
       destinationBytesPerRow:bytesPerRow
     destinationBytesPerImage:requiredSize];
        [blit endEncoding];
        [cmdBuf commit];
        [cmdBuf waitUntilCompleted];

        if (cmdBuf.error) {
            NSLog(@"[SyphonReceiver] ERROR: Metal blit command buffer failed: %@", cmdBuf.error);
            return -1;
        }

        // Copy from staging buffer to output with vertical flip + BGRA→RGBA if needed
        const uint8_t* src = static_cast<const uint8_t*>(bridge->stagingBuffer.contents);
        bool needSwap = (texture.pixelFormat == MTLPixelFormatBGRA8Unorm);
        for (uint32_t y = 0; y < h; y++) {
            const uint8_t* srcRow = src + (h - 1 - y) * bytesPerRow;
            uint8_t* dstRow = out_buffer + y * bytesPerRow;
            if (needSwap) {
                syphon_convert_bgra_to_rgba(srcRow, dstRow, w);
            } else {
                memcpy(dstRow, srcRow, bytesPerRow);
            }
        }

        // Flag was already consumed by exchange() at the top — no need to clear.

        return 0;
    }
}

int syphon_receiver_is_valid(SyphonReceiverHandle handle) {
    if (!handle) return 0;
    @autoreleasepool {
        auto* bridge = static_cast<SyphonReceiverBridge*>(handle);
        return bridge->client.isValid ? 1 : 0;
    }
}

uint32_t syphon_receiver_get_width(SyphonReceiverHandle handle) {
    if (!handle) return 0;
    auto* bridge = static_cast<SyphonReceiverBridge*>(handle);
    return bridge->lastWidth;
}

uint32_t syphon_receiver_get_height(SyphonReceiverHandle handle) {
    if (!handle) return 0;
    auto* bridge = static_cast<SyphonReceiverBridge*>(handle);
    return bridge->lastHeight;
}

int syphon_receiver_receive_shared_iosurface(SyphonReceiverHandle handle,
                                             void** out_iosurface,
                                             uint32_t* out_width,
                                             uint32_t* out_height,
                                             uint32_t* out_pixel_format) {
    if (!handle || !out_iosurface || !out_width || !out_height || !out_pixel_format) {
        return -1;
    }

    auto* bridge = static_cast<SyphonReceiverBridge*>(handle);
    *out_iosurface = nullptr;

    // This is the production consumer of the new-frame flag. The RGBA path
    // peeks via load() (see syphon_receiver_receive_rgba) so concurrent dual
    // polling does not silently drop frames on this path. See
    // docs/superpowers/plans/2026-04-22-mac-metal-shared-texture-receiver.md.
    if (!bridge->hasNewFrameFlag.exchange(false, std::memory_order_acq_rel)) {
        *out_width = bridge->lastWidth;
        *out_height = bridge->lastHeight;
        return 1; // no new frame
    }

    @autoreleasepool {
        id<MTLTexture> texture = [bridge->client newFrameImage];
        if (!texture) return -1;

        IOSurfaceRef sourceSurface = texture.iosurface;
        if (!sourceSurface) return -2; // Syphon textures should always be IOSurface-backed

        const uint32_t w = (uint32_t)texture.width;
        const uint32_t h = (uint32_t)texture.height;
        const MTLPixelFormat sourceFmt = texture.pixelFormat;

        bridge->lastWidth = w;
        bridge->lastHeight = h;

        const int32_t fmt_code = metal_pixel_format_to_code(sourceFmt);
        if (fmt_code < 0) {
            // Surface a clear error rather than silently lying about the
            // texture layout to importSharedTexture. Mirrors Windows
            // dxgi_format_to_pixel_format which Errs on unknown formats.
            *out_width = w;
            *out_height = h;
            return -3;
        }

        // (Re-)allocate the per-receiver staging IOSurface + MTLTexture if
        // this is the first frame or if dims/format changed since last frame.
        if (!bridge->sharedStagingTexture ||
            bridge->sharedStagingWidth != w ||
            bridge->sharedStagingHeight != h ||
            bridge->sharedStagingPixelFormat != sourceFmt) {
            if (!ensure_shared_staging(bridge, w, h, sourceFmt)) {
                return -2;
            }
            // Flag was already consumed by exchange() above. Restore it so
            // the next poll picks up this same frame and proceeds to blit.
            bridge->hasNewFrameFlag.store(true, std::memory_order_release);
            *out_width = w;
            *out_height = h;
            *out_pixel_format = (uint32_t)fmt_code;
            return 2; // dimensions/format changed — caller polls again
        }

        // Stage Syphon's vended texture into our owned staging texture so
        // Electron's imported texture is decoupled from Syphon's
        // pool-recycled IOSurface (the Windows ntStaging invariant). See
        // encode_stage_pass for the flipY=true (Y-flip render pass) vs
        // flipY=false (straight blit) selection.
        const bool flipY = bridge->flipY.load(std::memory_order_relaxed);
        id<MTLCommandBuffer> cmdBuf = [bridge->commandQueue commandBuffer];
        if (!encode_stage_pass(cmdBuf, texture, bridge->sharedStagingTexture, flipY,
                               bridge->device, bridge->yFlip)) {
            return -2;
        }
        [cmdBuf commit];
        [cmdBuf waitUntilCompleted];

        if (cmdBuf.error) {
            NSLog(@"[SyphonReceiver] receive_shared_iosurface stage failed (flipY=%d): %@",
                  flipY, cmdBuf.error);
            return -2;
        }

        // Mint a fresh per-frame retain on top of the bridge-owned retain.
        // The caller balances exactly one CFRelease against this CFRetain via
        // native_close_shared_iosurface — imported or not, since Electron's
        // importSharedTexture takes its own retain.
        CFRetain(bridge->sharedStagingIOSurface);

        *out_iosurface = (void*)bridge->sharedStagingIOSurface;
        *out_width = w;
        *out_height = h;
        *out_pixel_format = (uint32_t)fmt_code;
        return 0;
    }
}

// ============================================================
// Discovery (SyphonServerDirectory)
// ============================================================

char* syphon_discovery_list_servers(void) {
    @autoreleasepool {
        SyphonServerDirectory* dir = [SyphonServerDirectory sharedDirectory];
        NSArray* servers = dir.servers;

        NSMutableArray* result = [NSMutableArray array];
        for (NSDictionary* desc in servers) {
            NSMutableDictionary* entry = [NSMutableDictionary dictionary];
            NSString* name = desc[SyphonServerDescriptionNameKey];
            if (name) entry[@"name"] = name;
            else entry[@"name"] = @"";

            NSString* appName = desc[SyphonServerDescriptionAppNameKey];
            if (appName) entry[@"appName"] = appName;

            NSString* uuid = desc[SyphonServerDescriptionUUIDKey];
            if (uuid) entry[@"uuid"] = uuid;

            [result addObject:entry];
        }

        NSError* error = nil;
        NSData* jsonData = [NSJSONSerialization dataWithJSONObject:result
                                                           options:0
                                                             error:&error];
        if (error || !jsonData) {
            NSLog(@"[SyphonDiscovery] ERROR: Failed to serialize server list: %@", error);
            // Return empty array as fallback
            char* empty = strdup("[]");
            return empty;
        }

        NSString* jsonStr = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
        return strdup([jsonStr UTF8String]);
    }
}

void syphon_discovery_free_string(char* str) {
    if (str) free(str);
}

// ============================================================
// Pixel format utilities
// ============================================================

void syphon_convert_bgra_to_rgba(const uint8_t* src, uint8_t* dst, uint32_t pixel_count) {
    for (uint32_t i = 0; i < pixel_count; i++) {
        uint32_t off = i * 4;
        uint8_t b = src[off + 0];
        uint8_t g = src[off + 1];
        uint8_t r = src[off + 2];
        uint8_t a = src[off + 3];
        dst[off + 0] = r;
        dst[off + 1] = g;
        dst[off + 2] = b;
        dst[off + 3] = a;
    }
}

uint64_t syphon_map_pixel_format(uint32_t iosurface_pixel_format) {
    switch (iosurface_pixel_format) {
        case 'RGBA':
            return 70; // MTLPixelFormatRGBA8Unorm
        case 'BGRA':
            return 80; // MTLPixelFormatBGRA8Unorm
        default:
            return 80; // MTLPixelFormatBGRA8Unorm (safe default)
    }
}

void syphon_receiver_set_flip_y(SyphonReceiverHandle handle, int flip) {
    if (!handle) return;
    auto* bridge = static_cast<SyphonReceiverBridge*>(handle);
    bridge->flipY.store(flip != 0, std::memory_order_relaxed);
}

void syphon_receiver_set_frame_callback(SyphonReceiverHandle handle,
                                        syphon_frame_callback cb,
                                        void* ctx) {
    if (!handle) return;
    auto* bridge = static_cast<SyphonReceiverBridge*>(handle);
    std::lock_guard<std::mutex> lock(bridge->push->mutex);
    if (bridge->push->shuttingDown) return;
    bridge->push->callback = cb;
    bridge->push->callbackCtx = cb ? ctx : nullptr;
}

int32_t syphon_ring_pick_slot(const uint32_t* retain_counts,
                              const uint8_t* gpu_busy,
                              uint32_t n) {
    if (!retain_counts || !gpu_busy) return -1;
    for (uint32_t i = 0; i < n; i++) {
        if (retain_counts[i] == 1 && gpu_busy[i] == 0) return (int32_t)i;
    }
    return -1;
}

int32_t native_close_shared_iosurface(uintptr_t raw_ptr) {
    if (raw_ptr == 0) {
        NSLog(@"[SyphonBridge] native_close_shared_iosurface: null pointer");
        return -1;
    }
    IOSurfaceRef surface = reinterpret_cast<IOSurfaceRef>(raw_ptr);
    CFRelease(surface);
    return 0;
}

} // extern "C"
