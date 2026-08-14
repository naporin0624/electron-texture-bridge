# electron-texture-bridge

[![CI](https://github.com/naporin0624/electron-texture-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/naporin0624/electron-texture-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Bidirectional GPU texture sharing between Electron and VJ software via Spout / Syphon Metal.**

[日本語](lang/ja/README.md)

A napi-rs native addon for bidirectional GPU texture sharing with Electron. **Send** textures from Electron's offscreen rendering (`useSharedTexture`) to VJ software, or **receive** textures from external Syphon/Spout servers into your Electron app. Works with Resolume Arena, VDMX, OBS, TouchDesigner, and other Syphon/Spout-compatible applications.

## Install

```bash
npm i @napolab/texture-bridge-renderer
# or
pnpm add @napolab/texture-bridge-renderer
```

That one package pulls in the whole chain — prebuilt native binaries included. You normally depend on just it.

| Use case | Package | What it gives you |
|----------|---------|-------------------|
| **High-level (recommended)** | [`@napolab/texture-bridge-renderer`](https://www.npmjs.com/package/@napolab/texture-bridge-renderer) | `createTextureBridge()` — window + paint + sender + preview, all wired |
| Low-level (manual paint loop) | [`@napolab/texture-bridge-core`](https://www.npmjs.com/package/@napolab/texture-bridge-core) | `TextureSender` + `sendTextureFromPaintEvent()` |
| Native binding | [`@napolab/texture-bridge`](https://www.npmjs.com/package/@napolab/texture-bridge) | Raw napi-rs classes (`TextureSender`, `TextureReceiver`) |
| Prebuilt binary | `@napolab/texture-bridge-darwin-arm64`, etc. | Platform `.node`, resolved automatically via `optionalDependencies` |

Dependency direction: `texture-bridge-renderer` → `texture-bridge-core` → `texture-bridge` → `texture-bridge-<platform>`.

> Building from source, full prerequisites, packaging, and integration walkthroughs: **[docs/INSTALLATION.md](docs/INSTALLATION.md)**.

## AI Agent Skills

This repo ships **agent skills** that teach coding agents the real API surface of this library.

They exist because models asked to integrate texture-bridge without them consistently invent plausible-looking APIs that do not exist (`publishSharedTexture`, `subscribeFrames`, options objects that were never defined). Each skill was written test-first against those observed failures and verified to make an agent produce the actual API.

### Claude Code (plugin)

```
/plugin marketplace add naporin0624/electron-texture-bridge
/plugin install texture-bridge
```

### Any other agent (Skills CLI)

Works with Codex, GitHub Copilot, Amp, Cursor, Antigravity, and others via [skills.sh](https://skills.sh/naporin0624/electron-texture-bridge). **Install one skill per command** — passing several at once only installs the first:

```bash
npx skills add naporin0624/electron-texture-bridge@setting-up-texture-bridge
npx skills add naporin0624/electron-texture-bridge@choosing-texture-bridge-api
npx skills add naporin0624/electron-texture-bridge@migrating-to-forward-frames
npx skills add naporin0624/electron-texture-bridge@receiving-shared-textures
npx skills add naporin0624/electron-texture-bridge@managing-frame-forward-lifecycle
npx skills add naporin0624/electron-texture-bridge@delivering-imported-textures
npx skills add naporin0624/electron-texture-bridge@handling-texture-bridge-failures
npx skills add naporin0624/electron-texture-bridge@diagnosing-dead-frame-forwards
```

Add `-g` to install globally instead of into the current project.

> Omitting the `@skill-name` suffix installs **every** skill in the repository, including this project's own internal development-rule skills (`ci`, `smart-commit`, and others) that are not about texture-bridge at all. Name the skills you want.

### What each skill covers

Skills activate automatically from conversation context — there are no commands to learn.

| Skill | Fires when you ask about |
|-------|--------------------------|
| `setting-up-texture-bridge` | Installing the library, adding Syphon/Spout output to an Electron app, electron-vite config, black/garbled output right after setup |
| `choosing-texture-bridge-api` | Which API tier to use — simple vs core, `forwardSharedTexture` vs `forwardFrames`, send vs receive paths — and integration-plan review |
| `migrating-to-forward-frames` | Replacing `capturePage` polling / bitmap-IPC previews / Syphon loopbacks with zero-copy forwarding |
| `receiving-shared-textures` | The receiving side: consuming forwarded frames, multiviewer grids, `VideoFrame` lifecycle, frames reappearing after disconnect |
| `managing-frame-forward-lifecycle` | Registering and tearing down `forwardFrames` targets: monitor windows that close and reopen, repeated connect/disconnect, `MaxListenersExceededWarning`, leaks around forwarding |
| `delivering-imported-textures` | Delivering a texture to a renderer from main: `importSharedTexture` / `sendSharedTexture` / `release()` by hand, where `release()` belongs, `sendImportedTexture` vs `forwardSharedTexture` |
| `handling-texture-bridge-failures` | Error handling and telemetry: which calls throw, reject, model a defect, or emit — what to wrap with `Result.fromThrowable`, silently black output, a main-process crash from a bridge call |
| `diagnosing-dead-frame-forwards` | A forwarded preview/monitor that went black, froze on its last frame, or shows "no signal" — dead previews with nothing in the logs, or only some targets dying while Syphon/Spout keeps working |

## Quick Start

### Sending: Electron → VJ software

The factory handles offscreen window creation, paint event wiring, Syphon/Spout sender, and optional preview window — all in one call.

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

More sending recipes — capturing a live web page, transparency (`includeAlpha`), the low-level paint loop, DPI correctness, electron-vite (ESM) integration — are in **[docs/SENDING.md](docs/SENDING.md)**.

### Receiving: VJ software → Electron

Pull textures from external Syphon/Spout servers into your Electron app.

```typescript
// main process
import { app } from "electron";
import { createTextureReceiver, SenderDiscovery } from "@napolab/texture-bridge-renderer";

app.whenReady().then(() => {
  // Discover available servers
  const discovery = new SenderDiscovery();
  discovery.on("added", (senders) => {
    console.log("New senders:", senders);
  });
  discovery.start(1000); // Poll every second

  // Receive from a specific server
  const receiver = createTextureReceiver({
    senderName: "Resolume Arena",
  });

  receiver.on("frame", (frame) => {
    // frame: { data: Buffer, width: number, height: number }
    console.log(`Received ${frame.width}x${frame.height} frame`);
  });

  receiver.on("fps", (fps) => console.log(`Receive FPS: ${fps.toFixed(1)}`));
  receiver.start();

  // Clean up
  // receiver.dispose();
  // discovery.dispose();
});
```

That example uses the **RGBA readback** path. For the **zero-copy GPU** path (`createSharedTextureReceiver`, `consumeSharedTexture`, renderer context isolation), see **[docs/RECEIVING.md](docs/RECEIVING.md)**.

## Which API should I use?

```
Do you just want OSR (useSharedTexture) → Syphon/Spout, and let the library own the window?
  YES → createTextureBridge()  (@napolab/texture-bridge-renderer)
        Handles BrowserWindow, paint wiring, DPR/pixelExact, preview, FPS. Start here.

Do you have your own BrowserWindow / paint loop you want to bolt sending onto?
  YES → TextureSender + sendTextureFromPaintEvent()  (@napolab/texture-bridge-core)
        You own DPR correctness yourself — see docs/SENDING.md § "macOS Retina / Windows DPI".

Do you want to push raw RGBA without Electron at all (test / CI / sanity check)?
  YES → new TextureSender(...).sendRgbaBuffer()  (@napolab/texture-bridge-core)
        See docs/SENDING.md § "Minimal sanity check (no Electron)".
```

### Package roles and dependency direction

```
@napolab/texture-bridge-renderer   High-level factory API (recommended): createTextureBridge,
        │                          receivers, discovery, preview
        ▼
@napolab/texture-bridge-core       Low-level primitives: TextureSender / TextureReceiver,
        │                          sendTextureFromPaintEvent — Electron optional
        ▼
@napolab/texture-bridge            Native addon (napi-rs binding)
        │
        ▼
@napolab/texture-bridge-darwin-arm64 / -darwin-x64 / -win32-x64-msvc
                                   Prebuilt platform binaries (installed automatically)
```

## Architecture

### Sending (Electron → VJ Software)

```
[Web Worker]              [Chromium GPU Process]         [Native Addon]         [External Apps]
 Three.js / WebGL  ──→   Compositor (Metal / D3D11) ──→  texture-bridge  ──→   Resolume Arena
 OffscreenCanvas          Shared Texture (GPU)            Spout / Syphon        VDMX, OBS, etc.
```

The entire send pipeline stays on the GPU. No CPU readback. Sub-frame latency.

### Receiving (VJ Software → Electron)

Two paths are available depending on what you want to do with the frame:

**RGBA readback (works on both platforms):**

```
[External Apps]          [Native Addon]                  [Electron App]
 Resolume Arena   ──→    texture-bridge   ──→ RGBA buf ──→  Process frames
 VDMX, OBS, etc.         Syphon Client / Spout Receiver     Display, analyze, etc.
```

Involves a GPU→CPU readback (Metal blit / D3D11 staging) plus an ArrayBuffer IPC hop. Use when you need to inspect pixels in JS (analysis, save-to-disk, custom color pipelines).

**Zero-copy GPU shared texture (Windows + macOS):**

```
[External Apps]          [Native Addon]        [Electron main]         [Electron renderer]
 Resolume Arena   ──→   texture-bridge   ──→  importSharedTexture ──→  VideoFrame
 VDMX, OBS, etc.        Shared Handle /       + sendSharedTexture       drawImage / WebGPU
                        IOSurface             (zero-copy GPU)           importExternalTexture
```

The texture stays GPU-resident from the sender all the way to the consumer canvas or WebGPU device. No CPU readback, no IPC pixel copy — `drawImage(videoFrame, 0, 0)` is a GPU blit in Chromium when the source is a shared-texture-backed `VideoFrame`.

## Features

- **GPU Zero-Copy Sending**: Textures are shared directly on the GPU via IOSurface (macOS) or DXGI Shared Handle (Windows)
- **GPU Zero-Copy Receiving** (Windows + macOS): Pull textures from Syphon/Spout servers straight into a renderer `VideoFrame` via Electron's `importSharedTexture` — no CPU readback, no IPC pixel copy
- **Transparent Capture**: `includeAlpha: true` makes the offscreen window forward per-pixel alpha into the shared texture, so VJ software receives a layer with proper transparency for overlay / lower-third compositing
- **RGBA Readback Receiving**: `TextureReceiver.receiveFrame()` returns pixels as a `Buffer` on both platforms
- **Sender Discovery**: Enumerate available Syphon servers / Spout senders with real-time change events
- **Cross-Platform**: Syphon Metal on macOS, Spout on Windows
- **Electron Native**: Built for Electron 40+'s `useSharedTexture` paint events and `sharedTexture` module
- **WebGPU Preview**: Optional zero-copy preview window using `importExternalTexture`
- **Factory APIs**: `createTextureBridge()` for sending, `createTextureReceiver()` for RGBA readback, `createSharedTextureReceiver()` for zero-copy GPU delivery — handle all boilerplate
- **Low-Level API**: `sendTextureFromPaintEvent()`, `TextureReceiver`, and `closeNativeHandle()` for full control
- **napi-rs**: Type-safe Rust → Node.js bindings with prebuilt binaries

## Supported Platforms

| Platform | Protocol | GPU API | Target |
|----------|----------|---------|--------|
| macOS (Apple Silicon) | Syphon Metal | IOSurface + Metal | `aarch64-apple-darwin` |
| macOS (Intel) | Syphon Metal | IOSurface + Metal | `x86_64-apple-darwin` |
| Windows x64 | Spout | DXGI Shared Handle + D3D11 | `x86_64-pc-windows-msvc` |

### Feature support by platform

| Feature | Windows (Spout) | macOS (Syphon Metal) |
|---------|:---------------:|:--------------------:|
| Sender (Electron paint → external apps) | Yes | Yes |
| Receiver, RGBA readback (`receiveFrame()`) | Yes | Yes |
| Receiver, zero-copy GPU (`receiveSharedTexture()` + `createSharedTextureReceiver`) | Yes | Yes |
| Sender discovery (`listSenders()` / `SenderDiscovery`) | Yes | Yes |
| Transparent capture (`createTextureBridge({ includeAlpha: true })`) | Yes | Yes |

## Requirements

- **Node.js** 20+
- **Electron** 40.0.0+
- **macOS** 11.0+ (Metal), or **Windows** with a DirectX 11 compatible GPU

Building from source additionally needs a Rust toolchain, pnpm 10+, and platform build tools — see [docs/INSTALLATION.md § Prerequisites](docs/INSTALLATION.md#prerequisites).

## Performance

### Sending

| Path | GPU Copies | Latency | Memory |
|------|-----------|---------|--------|
| Syphon / Spout | 0 (zero-copy) | < 1 frame | Shared GPU memory |
| WebGPU Preview | 0 (zero-copy) | < 1 frame | Shared GPU memory |
| RGBA Buffer (fallback) | 1 (CPU → GPU) | 2-3 frames | CPU + GPU |

### Receiving

| Path | GPU Copies | IPC Copy | Latency | Notes |
|------|-----------|----------|---------|-------|
| Shared Texture (`createSharedTextureReceiver` / `receiveSharedTexture`) | 0 (zero-copy) | None (handle only) | < 1 frame | Windows + macOS. Frame delivered as `VideoFrame` — use `drawImage` or WebGPU `importExternalTexture` |
| RGBA Readback (`createTextureReceiver` / `receiveFrame`) | 1 (GPU → CPU staging) | ~8 MB per 1080p frame | 2–3 frames | Use when you actually need pixel data in JS |

Approx. readback bandwidth at 60 fps: ~500 MB/s at 1080p, ~2 GB/s at 4K — consider reducing poll rate or switching to the shared-texture path for display-only workloads.

## Example Application

The `packages/example/` directory contains a full VJ application demonstrating:

- **Three.js + GLSL raymarching** in an OffscreenCanvas Web Worker
- **SDF-based 3D visuals** with audio-reactive parameters
- **WebGPU preview window** with GPU zero-copy texture display
- **Syphon/Spout output** for integration with professional VJ software

```bash
# Run the example
pnpm dev:example
```

Look for "ElectronVJ-ThreeJS" in your Syphon/Spout receiver application.

### Multi-Receiver Grid (multiviewer)

The example also includes a second window that exercises `forwardFrames` end-to-end: **4 decks** (480×270 canvases) plus a **2×2 composite preview** (960×540) monitoring up to 4 sources at once. Each deck is independently assignable to one of two routes:

- **`[local]`** — an in-process bridge forwarded via `bridge.forwardFrames(multiviewerWindow.webContents, { extraArgs: [slot] })`, the new zero-copy renderer→renderer path this feature adds.
- **`[syphon]`** — an external Syphon/Spout sender received via the existing `createSharedTextureReceiver({ senderName, target, extraArgs: [slot] })` path.

The same source can be assigned to both routes at once (once forwarded directly, once round-tripped through Syphon/Spout) for side-by-side comparison. Four local sources ship out of the box so all 4 slots can be filled without any external sender: the example's own `ElectronVJ-ThreeJS` raymarching bridge, plus three lightweight `Grid-Demo-A/B/C` bridges (960×540, 30 fps, distinct hues). To iterate on the multiviewer alone, skip the heavy VJ bridge and the receiver-test window with `pnpm --filter @napolab/texture-bridge-example dev:multiviewer` (or `MULTIVIEWER_ONLY=1 electron-vite dev`) — the 3 `Grid-Demo-*` sources still fill the grid.

Each deck holds only its latest arrived frame; a `requestAnimationFrame` loop redraws whatever's held into the deck canvas and its composite quadrant on every tick, so draw cost is fixed to the display refresh rate regardless of how many slots are connected or how fast each source produces frames. Arrival fps (`onFrame` call rate) and draw fps (`rAF` draw rate) are tracked and shown separately per deck, since the two diverge whenever a source's frame rate and the display's refresh rate don't match.

The composite canvas is itself the "renderer-side atlas": the grid deliberately does **not** GPU-atlas the four sources into one texture before forwarding — atlasing would only save a handful of import/IPC calls per frame (not a bottleneck at this scale) at the cost of adding a main-process compositing pass and a frame of latency, which defeats the point of a low-latency multiviewer.

### Packaging the example

```bash
# macOS
pnpm --filter @napolab/texture-bridge-example run build:mac

# Windows
pnpm --filter @napolab/texture-bridge-example run build:win
```

> **Packaging your own app.** Native `.node` addons cannot load from inside an ASAR archive, so add `asarUnpack: "node_modules/@napolab/texture-bridge*"` to your electron-builder config, and on macOS bundle + codesign `Syphon.framework` into `Frameworks/`. Copy-pasteable electron-builder / electron-forge snippets are in [docs/INSTALLATION.md → Packaging for Distribution](docs/INSTALLATION.md#packaging-for-distribution).

## Documentation

| Document | What's in it |
|----------|--------------|
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Prerequisites, building from source, integrating into your app, packaging, verification |
| [docs/SENDING.md](docs/SENDING.md) | Capturing external pages, `includeAlpha` transparency, the low-level core paint loop, Retina/DPI correctness, no-Electron sanity check, electron-vite (ESM) |
| [docs/RECEIVING.md](docs/RECEIVING.md) | Both receive paths, `createSharedTextureReceiver`, `installSharedTextureReceiver` / `consumeSharedTexture`, handle ownership, renderer context isolation |
| [docs/API.md](docs/API.md) | Full API reference for every exported symbol in all three packages |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Black output, paint events not firing, freezing, receiver problems per platform |
| [docs/MIGRATION.md](docs/MIGRATION.md) | Electron 42 / OSR device scale, synchronous dispose (v0.14+), explicit disposal (v0.6+) |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Repository layout and CI |
| [specs/ARCHITECTURE.md](specs/ARCHITECTURE.md) | Detailed internal architecture |

## License

[MIT](LICENSE)
