# electron-texture-bridge

[![CI](https://github.com/naporin0624/electron-texture-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/naporin0624/electron-texture-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**GPU zero-copy texture sharing from Electron to VJ software via Spout / Syphon Metal.**

[日本語](lang/ja/README.md)

A napi-rs native addon that captures GPU textures from Electron's offscreen rendering (`useSharedTexture`) and shares them with external applications like Resolume Arena, VDMX, OBS, TouchDesigner, and other Syphon/Spout-compatible receivers — all without CPU readback.

## Architecture

```
[Web Worker]              [Chromium GPU Process]         [Native Addon]         [External Apps]
 Three.js / WebGL  ──→   Compositor (Metal / D3D11) ──→  texture-bridge  ──→   Resolume Arena
 OffscreenCanvas          Shared Texture (GPU)            Spout / Syphon        VDMX, OBS, etc.
```

The entire pipeline stays on the GPU. No CPU readback. Sub-frame latency.

## Features

- **GPU Zero-Copy**: Textures are shared directly on the GPU via IOSurface (macOS) or DXGI Shared Handle (Windows)
- **Cross-Platform**: Syphon Metal on macOS, Spout on Windows
- **Electron Native**: Built for Electron 40+'s `useSharedTexture` paint event API
- **WebGPU Preview**: Optional zero-copy preview window using `importExternalTexture`
- **Factory API**: `createTextureBridge()` handles all boilerplate — offscreen window, paint events, preview, FPS tracking
- **Low-Level API**: `sendTextureFromPaintEvent()` for full control over the pipeline
- **napi-rs**: Type-safe Rust → Node.js bindings with prebuilt binaries

## Supported Platforms

| Platform | Protocol | GPU API | Target |
|----------|----------|---------|--------|
| macOS (Apple Silicon) | Syphon Metal | IOSurface + Metal | `aarch64-apple-darwin` |
| macOS (Intel) | Syphon Metal | IOSurface + Metal | `x86_64-apple-darwin` |
| Windows x64 | Spout | DXGI Shared Handle + D3D11 | `x86_64-pc-windows-msvc` |

## Requirements

- **Node.js** 20+
- **pnpm** 10+
- **Rust** toolchain (via [rustup](https://rustup.rs/))
- **Electron** 40.0.0+

### macOS

- Xcode Command Line Tools
- macOS 11.0+ (Metal support)

### Windows

- Visual Studio Build Tools 2019+ with "Desktop development with C++" workload
- Windows SDK 10.0.19041.0+
- DirectX 11 compatible GPU

## Installation

> **Detailed guide:** See [docs/INSTALLATION.md](docs/INSTALLATION.md) for step-by-step instructions covering prerequisites, building from source, integration, packaging, and troubleshooting.

### As a library (recommended)

```bash
npm install @napolab/texture-bridge-renderer
# or
pnpm add @napolab/texture-bridge-renderer
```

`@napolab/texture-bridge-renderer` is the high-level package for most users. It includes `@napolab/texture-bridge-core` and `@napolab/texture-bridge` as dependencies.

For advanced use cases that need direct control over the pipeline:

```bash
npm install @napolab/texture-bridge-core
```

### Building from source

```bash
# Clone with submodules (Syphon source)
git clone --recursive https://github.com/naporin0624/electron-texture-bridge.git
cd electron-texture-bridge
```

#### macOS: Build Syphon Framework

```bash
cd vendor/syphon-src
xcodebuild -project Syphon.xcodeproj \
  -scheme Syphon \
  -configuration Release \
  -derivedDataPath build \
  ONLY_ACTIVE_ARCH=NO \
  BUILD_LIBRARY_FOR_DISTRIBUTION=YES
cp -R build/Build/Products/Release/Syphon.framework ../Syphon.framework
cd ../..
```

#### Windows: Fetch Spout2 SDK

```powershell
git clone --depth 1 https://github.com/leadedge/Spout2.git _spout2_tmp
Copy-Item -Recurse _spout2_tmp/SPOUTSDK/SpoutDirectX/SpoutDX vendor/SpoutDX
Remove-Item -Recurse -Force _spout2_tmp
```

#### Build

```bash
pnpm install
pnpm build          # Builds native addon + core + renderer packages
```

## Quick Start

```typescript
// main process — that's it, GPU textures are now shared to VJ software
import { createTextureBridge } from "@napolab/texture-bridge-renderer";

const bridge = await createTextureBridge({
  name: "MyApp",
  width: 1920,
  height: 1080,
  rendererUrl: "path/to/index.html", // your WebGL/Canvas page
});
```

### High-Level: Factory API (recommended)

The simplest way to use electron-texture-bridge. The factory handles offscreen window creation, paint event wiring, Syphon/Spout sender, and optional preview window — all in one call.

```typescript
// main process
import { app } from "electron";
import { createTextureBridge } from "@napolab/texture-bridge-renderer";

app.whenReady().then(async () => {
  const bridge = await createTextureBridge({
    name: "MyApp",
    width: 1920,
    height: 1080,
    frameRate: 60,
    rendererUrl: "path/to/index.html",  // Your renderer page with Web Worker
    preview: { enabled: true },
  });

  bridge.on("fps", (fps) => console.log(`FPS: ${fps.toFixed(1)}`));
  bridge.resize(3840, 2160);  // Resizes all layers automatically
  // bridge.dispose();         // Clean up when done
});
```

```html
<!-- renderer page (index.html) -->
<canvas id="canvas" width="1920" height="1080"></canvas>
<script type="module">
  import MyWorker from './my-worker?worker';
  const canvas = document.getElementById('canvas');
  const offscreen = canvas.transferControlToOffscreen();
  const worker = new MyWorker();
  worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
</script>
```

### Low-Level: Core API

For full control over the pipeline, use `@napolab/texture-bridge-core` directly.

```typescript
import { BrowserWindow } from "electron";
import { TextureSender, sendTextureFromPaintEvent } from "@napolab/texture-bridge-core";

const win = new BrowserWindow({
  width: 1920,
  height: 1080,
  show: false,
  webPreferences: {
    offscreen: { useSharedTexture: true },
  },
});

const sender = new TextureSender("MyApp", 1920, 1080);

win.webContents.on("paint", (event) => {
  const texture = event.texture;
  if (!texture) return;
  try {
    sendTextureFromPaintEvent(sender, texture.textureInfo);
  } finally {
    texture.release?.(); // IMPORTANT: Always release to prevent GPU memory leaks
  }
});

win.webContents.setFrameRate(60);
```

## API Reference

### `@napolab/texture-bridge-renderer`

#### `createTextureBridge(options): Promise<TextureBridge>`

Factory function that creates a fully-wired texture bridge. Must be called after `app.whenReady()`.

```typescript
interface TextureBridgeOptions {
  name: string;            // Syphon/Spout sender name
  width: number;           // Texture width in pixels
  height: number;          // Texture height in pixels
  frameRate?: number;      // Target frame rate (default: 60)
  rendererUrl: string;     // URL to load (file path, file://, or http://)
  preview?: PreviewOptions;
  webPreferences?: Electron.WebPreferences;
}

interface PreviewOptions {
  enabled?: boolean;       // Open preview window (default: false)
  width?: number;          // Preview window width
  height?: number;         // Preview window height
  title?: string;          // Preview window title
}
```

#### `TextureBridge`

The returned handle provides:

```typescript
interface TextureBridge {
  on(event: "fps", listener: (fps: number) => void): this;
  on(event: "ready", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "resize", listener: (width: number, height: number) => void): this;
  on(event: "disposed", listener: () => void): this;

  resize(width: number, height: number): void;  // Cascades to all layers + Worker
  openPreview(): void;
  closePreview(): void;
  dispose(): void;

  readonly renderWindow: BrowserWindow;
  readonly previewWindow: BrowserWindow | null;
  readonly isDisposed: boolean;
}
```

#### `createWorkerRenderer(options)` (from `renderer/client`)

Renderer-process helper for setting up a canvas-to-Worker pipeline with automatic resize propagation.

```typescript
import { createWorkerRenderer } from "@napolab/texture-bridge-renderer/client";

createWorkerRenderer({
  worker: new MyWorker(),
  width: 1920,
  height: 1080,
});
```

#### Worker Protocol Types (from `renderer/worker`)

```typescript
import type { WorkerMessage } from "@napolab/texture-bridge-renderer/worker";

// In your Worker:
self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  switch (e.data.type) {
    case "init":   /* e.data.canvas: OffscreenCanvas */ break;
    case "resize": /* e.data.width, e.data.height */   break;
    case "dispose": break;
  }
};
```

### `@napolab/texture-bridge-core`

#### `sendTextureFromPaintEvent(sender, textureInfo)`

Low-level convenience function that handles platform-specific texture handle extraction and forwarding.

- **macOS**: Reads `handle.ioSurface` buffer → calls `sender.sendSurface()`
- **Windows**: Reads `handle.ntHandle` buffer as BigInt64LE → calls `sender.send()`

#### `TextureSender`

Native class for sending textures to Syphon/Spout receivers.

```typescript
class TextureSender {
  constructor(name: string, width: number, height: number);
  send(handle: number, width: number, height: number): void;
  sendSurface(surfaceBuffer: Buffer, width: number, height: number): void;
  sendRgbaBuffer(data: Buffer, width: number, height: number, bytesPerRow?: number): void;
  platform(): string;
  stop(): void;
}
```

#### `getPlatform()`

```typescript
function getPlatform(): "spout" | "syphon-metal" | "unsupported";
```

#### Types

```typescript
type PixelFormat = "bgra" | "nv12" | "rgba" | "rgbaf16";

interface TextureInfo {
  pixelFormat: PixelFormat;
  codedSize: { width: number; height: number };
  visibleRect: { x: number; y: number; width: number; height: number };
  handle: {
    ntHandle?: Buffer;   // Windows (Electron 40+)
    ioSurface?: Buffer;  // macOS
  };
}

interface PaintTexture {
  textureInfo: TextureInfo;
  release?: () => void;
}

type Platform = "spout" | "syphon-metal" | "unsupported";
```

## Performance

| Path | GPU Copies | Latency | Memory |
|------|-----------|---------|--------|
| Syphon / Spout | 0 (zero-copy) | < 1 frame | Shared GPU memory |
| WebGPU Preview | 0 (zero-copy) | < 1 frame | Shared GPU memory |
| RGBA Buffer (fallback) | 1 (CPU → GPU) | 2-3 frames | CPU + GPU |

## Example Application

The `packages/example/` directory contains a full VJ application demonstrating:

- **Three.js + GLSL shaders** in an OffscreenCanvas Web Worker
- **3 switchable scenes**: Raymarching (3D SDF), Julia set fractal, Voronoi flow field
- **Keyboard switching**: Press `1` / `2` / `3` to switch scenes live
- **Audio-reactive parameters** driving all scenes
- **WebGPU preview window** with GPU zero-copy texture display
- **Syphon/Spout output** for integration with professional VJ software

```bash
# Run the example
pnpm dev:example
```

Look for "ElectronVJ-ThreeJS" in your Syphon/Spout receiver application.

### Packaging the example

```bash
# macOS
pnpm --filter @napolab/texture-bridge-example run build:mac

# Windows
pnpm --filter @napolab/texture-bridge-example run build:win
```

## Project Structure

```
electron-texture-bridge/
├── packages/
│   ├── native/                # @napolab/texture-bridge (napi-rs)
│   │   ├── src/
│   │   │   ├── lib.rs         # napi-rs entry point, TextureSender API
│   │   │   ├── types.rs       # RawTextureHandle type alias
│   │   │   ├── mac/           # macOS: Syphon Metal sender + FFI
│   │   │   └── win/           # Windows: Spout sender + FFI
│   │   ├── cpp/
│   │   │   ├── mac/           # ObjC++ Syphon Metal bridge
│   │   │   └── win/           # C++ Spout bridge
│   │   ├── build.rs           # Platform-specific build configuration
│   │   └── Cargo.toml
│   ├── core/                  # @napolab/texture-bridge-core (TypeScript)
│   │   └── src/
│   │       ├── index.ts       # sendTextureFromPaintEvent + re-exports
│   │       └── types.ts       # TextureInfo, PaintTexture types
│   ├── renderer/              # @napolab/texture-bridge-renderer (TypeScript)
│   │   └── src/
│   │       ├── index.ts       # createTextureBridge factory
│   │       ├── bridge.ts      # Factory implementation (EventEmitter)
│   │       ├── types.ts       # TextureBridgeOptions, TextureBridge
│   │       ├── preview-manager.ts  # Preview window lifecycle
│   │       ├── fps-counter.ts # FPS measurement utility
│   │       ├── client/        # Renderer-process helpers
│   │       │   ├── index.ts   # createWorkerRenderer
│   │       │   └── worker-protocol.ts  # Worker message types
│   │       └── assets/        # Static files (preview.html, preload)
│   └── example/               # Electron VJ demo app (private)
│       └── src/
│           ├── main/          # Electron main process (~30 LOC)
│           └── renderer/      # Three.js + GLSL + Web Worker
├── vendor/                    # Third-party SDKs (gitignored, built locally)
│   ├── syphon-src/            # Syphon Framework source (git submodule)
│   ├── Syphon.framework/     # Built framework (macOS)
│   └── SpoutDX/              # Spout SDK (Windows)
├── specs/
│   └── ARCHITECTURE.md        # Detailed architecture documentation
├── Cargo.toml                 # Rust workspace root
├── pnpm-workspace.yaml        # pnpm monorepo config
└── package.json               # Root workspace scripts
```

## Troubleshooting

### Paint event not firing

- Ensure `win.webContents.setFrameRate(60)` is set
- Paint events fire even with `show: false`
- Verify that a `requestAnimationFrame` loop is running in the renderer/worker

### Black texture output

- `preserveDrawingBuffer` is not needed (Chromium compositor reads directly)
- Check pixel format mismatch: Chromium outputs BGRA, ensure the receiver expects BGRA

### Syphon receiver not showing output (macOS)

- Verify `vendor/Syphon.framework` exists and was built correctly
- Clear Gatekeeper quarantine: `xattr -dr com.apple.quarantine vendor/Syphon.framework`
- Check Console.app for error logs

### Spout receiver not showing output (Windows)

- Verify Spout2 is installed on the system
- Ensure GPU drivers are up to date
- DirectX 11 compatible GPU is required

### Freezing / paint events stop

- **Always call `texture.release()`** after processing. The texture pool is small (a few frames). Failing to release will exhaust the pool and stall the paint event pipeline.
- When using `createTextureBridge()`, this is handled automatically.
- When using the low-level core API, use `try/finally`:

```typescript
win.webContents.on("paint", (event) => {
  const texture = event.texture;
  if (!texture) return;
  try {
    sendTextureFromPaintEvent(sender, texture.textureInfo);
  } finally {
    texture.release?.();
  }
});
```

## CI/CD

GitHub Actions builds native binaries for all supported platforms:

| Runner | Target | Output |
|--------|--------|--------|
| `macos-14` | `aarch64-apple-darwin` | `texture-bridge.darwin-arm64.node` |
| `macos-13` | `x86_64-apple-darwin` | `texture-bridge.darwin-x64.node` |
| `windows-latest` | `x86_64-pc-windows-msvc` | `texture-bridge.win32-x64-msvc.node` |

Publishing to npm is triggered by version tags (`v*`).

## License

[MIT](LICENSE)
