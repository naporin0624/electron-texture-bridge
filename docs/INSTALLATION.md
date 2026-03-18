# Installation Guide

This guide covers every step to get electron-texture-bridge running, whether you are **using it as a library** in your Electron app or **building from source** to contribute.

## Table of Contents

- [Quick Install (npm)](#quick-install-npm)
- [Prerequisites](#prerequisites)
  - [All Platforms](#all-platforms)
  - [macOS](#macos)
  - [Windows](#windows)
- [Building from Source](#building-from-source)
  - [1. Clone the Repository](#1-clone-the-repository)
  - [2. Prepare Vendor SDKs](#2-prepare-vendor-sdks)
  - [3. Install Dependencies and Build](#3-install-dependencies-and-build)
  - [4. Run the Example App](#4-run-the-example-app)
- [Integrating into Your Electron App](#integrating-into-your-electron-app)
  - [Project Setup](#project-setup)
  - [Main Process (High-Level API)](#main-process-high-level-api)
  - [Main Process (Low-Level API)](#main-process-low-level-api)
  - [Renderer Process](#renderer-process)
  - [Web Worker](#web-worker)
- [Packaging for Distribution](#packaging-for-distribution)
  - [electron-builder](#electron-builder)
  - [electron-forge](#electron-forge)
  - [macOS: Bundling Syphon.framework](#macos-bundling-syphonframework)
- [Verifying the Installation](#verifying-the-installation)
- [Troubleshooting](#troubleshooting)

---

## Quick Install (npm)

If prebuilt binaries are published to npm, this is all you need:

```bash
# Recommended: high-level API (includes core + native)
npm install @napolab/texture-bridge-renderer
# or
pnpm add @napolab/texture-bridge-renderer
```

For direct pipeline control without the factory:

```bash
npm install @napolab/texture-bridge-core
```

> **Note:** Prebuilt native binaries are automatically resolved via `optionalDependencies`. No Rust toolchain is needed when installing from npm.

---

## Prerequisites

### All Platforms

| Tool | Version | Check | Install |
|------|---------|-------|---------|
| **Node.js** | 20+ | `node -v` | [nodejs.org](https://nodejs.org/) |
| **pnpm** | 10+ | `pnpm -v` | `corepack enable && corepack prepare pnpm@latest --activate` |
| **Rust** | stable (1.75+) | `rustc --version` | [rustup.rs](https://rustup.rs/) |
| **Electron** | 40.0.0+ | `npx electron -v` | Installed as a project dependency |

#### Installing Node.js

We recommend [fnm](https://github.com/Schniz/fnm) or [volta](https://volta.sh/) for version management:

```bash
# fnm
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 22
fnm use 22

# or volta
curl https://get.volta.sh | bash
volta install node@22
```

#### Installing pnpm

pnpm 10+ is required for the monorepo workspace:

```bash
# Via corepack (recommended, ships with Node.js 16.13+)
corepack enable
corepack prepare pnpm@latest --activate

# Verify
pnpm -v
```

#### Installing Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Verify
rustc --version
cargo --version
```

On Windows, download and run [rustup-init.exe](https://rustup.rs/) instead.

### macOS

| Requirement | Version | Check |
|-------------|---------|-------|
| **macOS** | 11.0+ (Big Sur) | `sw_vers` |
| **Xcode CLI Tools** | Latest | `xcode-select -p` |
| **Metal** | GPU support required | All Macs since 2012 |

```bash
# Install Xcode Command Line Tools
xcode-select --install

# Verify
clang --version
xcodebuild -version
```

If you need cross-compilation (e.g., building for Intel on Apple Silicon):

```bash
# Add the x86_64 Rust target
rustup target add x86_64-apple-darwin
```

### Windows

| Requirement | Version | Check |
|-------------|---------|-------|
| **Windows** | 10+ (build 19041+) | `winver` |
| **VS Build Tools** | 2019+ | See below |
| **Windows SDK** | 10.0.19041.0+ | Included with VS |
| **DirectX 11** | GPU support required | Most GPUs since 2010 |

#### Installing Visual Studio Build Tools

1. Download [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. In the installer, select **"Desktop development with C++"**
3. Ensure these components are checked:
   - MSVC v143 - VS 2022 C++ x64/x86 build tools
   - Windows 10/11 SDK (10.0.19041.0 or later)

Alternatively, with `winget`:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Verify:

```powershell
# Opens a Developer Command Prompt
cl.exe
# Should show the MSVC version
```

---

## Building from Source

### 1. Clone the Repository

```bash
# Clone with submodules (required for Syphon source)
git clone --recursive https://github.com/naporin0624/electron-texture-bridge.git
cd electron-texture-bridge
```

If you already cloned without `--recursive`:

```bash
git submodule update --init --recursive
```

Verify the submodule is present:

```bash
ls vendor/syphon-src/Syphon.xcodeproj
# Should show the Xcode project file
```

### 2. Prepare Vendor SDKs

The native addon requires platform-specific SDKs in the `vendor/` directory. You only need to set up the SDK for your current platform.

#### macOS: Build Syphon.framework

Build Syphon Metal framework from the git submodule:

```bash
cd vendor/syphon-src

xcodebuild -project Syphon.xcodeproj \
  -scheme Syphon \
  -configuration Release \
  -derivedDataPath build \
  ONLY_ACTIVE_ARCH=NO \
  BUILD_LIBRARY_FOR_DISTRIBUTION=YES

# Copy the built framework to vendor/
cp -R build/Build/Products/Release/Syphon.framework ../Syphon.framework

cd ../..
```

Verify:

```bash
ls vendor/Syphon.framework/Syphon
# Should show the framework binary

# Clear quarantine (prevents "unverified developer" errors)
xattr -dr com.apple.quarantine vendor/Syphon.framework
```

> **Tip:** If `xcodebuild` fails, ensure you have accepted the Xcode license: `sudo xcodebuild -license accept`

#### Windows: Fetch Spout2 SDK

Download the SpoutDX source files from the Spout2 repository:

**PowerShell:**

```powershell
git clone --depth 1 https://github.com/leadedge/Spout2.git _spout2_tmp
Copy-Item -Recurse _spout2_tmp\SPOUTSDK\SpoutDirectX\SpoutDX vendor\SpoutDX
Remove-Item -Recurse -Force _spout2_tmp
```

**Bash (Git Bash / WSL):**

```bash
git clone --depth 1 https://github.com/leadedge/Spout2.git _spout2_tmp
cp -r _spout2_tmp/SPOUTSDK/SpoutDirectX/SpoutDX vendor/SpoutDX
rm -rf _spout2_tmp
```

Verify:

```bash
ls vendor/SpoutDX/SpoutDX.h
# Should show the header file
```

### 3. Install Dependencies and Build

```bash
# Install all workspace dependencies
pnpm install

# Build everything (native addon -> core -> renderer)
pnpm build
```

This runs the following in order:
1. **`pnpm build:native`** — Compiles the Rust native addon via napi-rs, producing a `.node` file (e.g., `texture-bridge.darwin-arm64.node`)
2. **`pnpm build:core`** — Bundles the TypeScript core package (CJS + ESM)
3. **`pnpm build:renderer`** — Bundles the TypeScript renderer package (CJS + ESM) and copies static assets

You can build individual packages:

```bash
pnpm build:native     # Only the native addon
pnpm build:core       # Only the core package
pnpm build:renderer   # Only the renderer package
```

### 4. Run the Example App

```bash
pnpm dev:example
```

This starts the Three.js raymarching VJ demo with:
- An offscreen window rendering 1920x1080 at 120fps
- Syphon/Spout output named "ElectronVJ-ThreeJS"
- A WebGPU preview window (960x540)

Open your Syphon/Spout receiver app and look for **"ElectronVJ-ThreeJS"**.

---

## Integrating into Your Electron App

### Project Setup

```bash
# Create a new Electron project (or use your existing one)
mkdir my-vj-app && cd my-vj-app
pnpm init
pnpm add electron@latest @napolab/texture-bridge-renderer
```

Ensure your Electron version is 40.0.0+:

```bash
npx electron -v
# Should output v40.x.x or higher
```

### Main Process (High-Level API)

The recommended approach uses the factory API which handles all boilerplate:

```typescript
// src/main.ts
import { app, BrowserWindow, globalShortcut } from "electron";
import path from "path";
import { createTextureBridge } from "@napolab/texture-bridge-renderer";

app.whenReady().then(async () => {
  const bridge = await createTextureBridge({
    name: "MyVJApp",             // Syphon/Spout server name
    width: 1920,
    height: 1080,
    frameRate: 60,
    rendererUrl: path.join(__dirname, "renderer/index.html"),
    preview: {
      enabled: true,             // Open a WebGPU preview window
      width: 960,
      height: 540,
    },
  });

  // Monitor FPS
  bridge.on("fps", (fps) => {
    console.log(`FPS: ${fps.toFixed(1)}`);
  });

  // Handle errors
  bridge.on("error", (err) => {
    console.error("Bridge error:", err.message);
  });

  // Dynamic resize
  // bridge.resize(3840, 2160);

  // Cleanup on quit
  app.on("before-quit", () => {
    bridge.dispose();
  });
});

app.on("window-all-closed", () => app.quit());
```

### Main Process (Low-Level API)

For full control over the pipeline:

```typescript
// src/main.ts
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

const sender = new TextureSender("MyVJApp", 1920, 1080);

win.webContents.on("paint", (event) => {
  const texture = event.texture;
  if (!texture) return;
  try {
    sendTextureFromPaintEvent(sender, texture.textureInfo);
  } finally {
    texture.release?.(); // CRITICAL: always release to prevent GPU memory leaks
  }
});

win.webContents.setFrameRate(60);
win.loadFile("renderer/index.html");
```

### Renderer Process

```html
<!-- renderer/index.html -->
<!DOCTYPE html>
<html>
<body>
  <canvas id="canvas" width="1920" height="1080"></canvas>
  <script type="module">
    import MyWorker from "./worker.js";

    const canvas = document.getElementById("canvas");
    const offscreen = canvas.transferControlToOffscreen();
    const worker = new MyWorker();
    worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);
  </script>
</body>
</html>
```

Or use the renderer helper for automatic resize propagation:

```typescript
// renderer/index.ts
import { createWorkerRenderer } from "@napolab/texture-bridge-renderer/client";
import MyWorker from "./worker?worker";

createWorkerRenderer({
  worker: new MyWorker(),
  width: 1920,
  height: 1080,
});
```

### Web Worker

```typescript
// renderer/worker.ts
import type { WorkerMessage } from "@napolab/texture-bridge-renderer/worker";

let canvas: OffscreenCanvas;
let ctx: OffscreenCanvasRenderingContext2D;

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  switch (e.data.type) {
    case "init":
      canvas = e.data.canvas;
      ctx = canvas.getContext("2d")!;
      requestAnimationFrame(render);
      break;
    case "resize":
      canvas.width = e.data.width;
      canvas.height = e.data.height;
      break;
    case "dispose":
      // Cleanup resources
      break;
  }
};

function render() {
  // Your rendering logic here
  ctx.fillStyle = `hsl(${Date.now() % 360}, 100%, 50%)`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  requestAnimationFrame(render);
}
```

---

## Packaging for Distribution

### electron-builder

Add to your `electron-builder.yml` (or equivalent config):

```yaml
asarUnpack:
  - node_modules/@napolab/texture-bridge*

# macOS: bundle Syphon.framework
mac:
  extraFiles:
    - from: path/to/Syphon.framework
      to: Frameworks/Syphon.framework
```

The `asarUnpack` is critical because native `.node` addons cannot be loaded from inside an ASAR archive.

### electron-forge

In `forge.config.js`:

```javascript
module.exports = {
  packagerConfig: {
    asar: {
      unpack: "**/node_modules/@napolab/texture-bridge*/**",
    },
    // macOS: copy Syphon.framework
    extraResource: [
      "./node_modules/@napolab/texture-bridge/Syphon.framework",
    ],
  },
};
```

### macOS: Bundling Syphon.framework

When distributing a macOS app, `Syphon.framework` must be codesigned and included in the app bundle. The native addon's `build.rs` already configures the `@executable_path/../Frameworks` rpath, so placing the framework at `YourApp.app/Contents/Frameworks/Syphon.framework` is the correct path.

For code signing:

```bash
codesign --deep --force --sign "Developer ID Application: Your Name" \
  YourApp.app/Contents/Frameworks/Syphon.framework
```

---

## Verifying the Installation

### 1. Check the native addon loads

```bash
node -e "const n = require('@napolab/texture-bridge'); console.log('Platform:', n.getPlatform())"
```

Expected output:
- macOS: `Platform: syphon-metal`
- Windows: `Platform: spout`

### 2. Check Syphon/Spout receiver visibility

1. Start your app (or the example: `pnpm dev:example`)
2. Open a Syphon/Spout receiver:
   - **macOS:** [Syphon Recorder](http://syphon.v002.info/recorder/), [Simple Client](http://syphon.v002.info/) or VDMX
   - **Windows:** [SpoutReceiver](https://spout.zeal.co/) (included with Spout2 install), Resolume, OBS with Spout plugin
3. You should see the sender name (e.g., "ElectronVJ-ThreeJS") listed

### 3. Check FPS output

The example app logs FPS to stdout:

```
[example] FPS: 59.8
[example] FPS: 60.0
```

If FPS is 0 or very low, see [Troubleshooting](#troubleshooting).

---

## Troubleshooting

### Build Errors

#### `xcodebuild: error: ... Syphon.xcodeproj`

The Syphon submodule was not cloned:

```bash
git submodule update --init --recursive
```

#### `fatal error: 'SpoutDX.h' file not found`

The Spout SDK was not fetched:

```bash
git clone --depth 1 https://github.com/leadedge/Spout2.git _spout2_tmp
cp -r _spout2_tmp/SPOUTSDK/SpoutDirectX/SpoutDX vendor/SpoutDX
rm -rf _spout2_tmp
```

#### `error: linker 'link.exe' not found` (Windows)

Visual Studio Build Tools are not installed or not in PATH. Install "Desktop development with C++" workload and restart your terminal.

#### `error[E0463]: can't find crate for 'napi'`

Rust dependencies not fetched:

```bash
cd packages/native
cargo fetch
cd ../..
pnpm build:native
```

#### `error: framework not found Syphon` (macOS)

`vendor/Syphon.framework` is missing or in the wrong location:

```bash
ls vendor/Syphon.framework/Syphon
# If this file doesn't exist, rebuild:
cd vendor/syphon-src
xcodebuild -project Syphon.xcodeproj -scheme Syphon -configuration Release \
  -derivedDataPath build ONLY_ACTIVE_ARCH=NO BUILD_LIBRARY_FOR_DISTRIBUTION=YES
cp -R build/Build/Products/Release/Syphon.framework ../Syphon.framework
cd ../..
```

### Runtime Errors

#### `Error: Cannot find module '..../texture-bridge.darwin-arm64.node'`

The native addon was not built for your platform. Rebuild:

```bash
pnpm build:native
```

#### `Error: dlopen ... Syphon ... image not found` (macOS)

Syphon.framework is not found at runtime. Ensure it exists at `vendor/Syphon.framework` and clear quarantine:

```bash
xattr -dr com.apple.quarantine vendor/Syphon.framework
```

For packaged apps, ensure Syphon.framework is in `Contents/Frameworks/`.

#### Paint event not firing

- Confirm `offscreen: { useSharedTexture: true }` in `webPreferences`
- Confirm `win.webContents.setFrameRate(60)` is called
- Confirm a `requestAnimationFrame` loop is running in the renderer/worker
- Paint events fire even with `show: false`

#### Black texture in receiver

- Check pixel format: Chromium outputs BGRA. Ensure your receiver expects BGRA.
- `preserveDrawingBuffer` is **not** needed (Chromium compositor reads directly).
- Verify the rendering worker is producing visible output (check the preview window).

#### GPU memory leak / freezing

**Always call `texture.release()`** after processing each paint event. The GPU texture pool is small (a few frames). Failing to release will stall the pipeline.

When using `createTextureBridge()`, release is handled automatically. With the low-level API, use `try/finally`:

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
