# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

electron-texture-bridge is a napi-rs native addon that enables GPU zero-copy texture sharing from Electron apps to VJ software (Resolume, VDMX, etc.) via Spout (Windows) and Syphon Metal (macOS). It captures textures from Electron's `paint` event (requires Electron 40+ `useSharedTexture` API) and shares them without CPU readback.

## Monorepo Structure

pnpm workspace monorepo with four packages:

- **`packages/native`** (`@napolab/texture-bridge`) — napi-rs Rust addon. Contains Rust src, C++/ObjC++ bridge code in `cpp/`, and `build.rs` for platform-specific compilation. Generates `.node` binary files.
- **`packages/core`** (`@napolab/texture-bridge-core`) — TypeScript wrapper. Re-exports native bindings and adds `sendTextureFromPaintEvent()` helper that handles platform-specific handle extraction. Dual CJS+ESM output via tsdown.
- **`packages/renderer`** (`@napolab/texture-bridge-renderer`) — High-level factory API. `createTextureBridge()` automates BrowserWindow creation, paint event handling, preview window, and FPS tracking. Also exports `./client` (renderer-process helper) and `./worker` (protocol types). Dual CJS+ESM output via tsdown + static assets.
- **`packages/example`** (`@napolab/texture-bridge-example`, private) — Electron VJ demo app using Three.js raymarching in a Web Worker, with WebGPU preview window.

`vendor/` at repo root contains third-party SDKs (Syphon.framework, SpoutDX) — these are gitignored and must be built/fetched before compiling native addon.

## Build Commands

```bash
# Install dependencies
pnpm install

# Build everything (native addon → core → renderer)
pnpm build

# Build individual packages
pnpm build:native          # napi-rs compile (requires Rust + platform SDK)
pnpm build:core            # TypeScript compile
pnpm build:renderer        # TypeScript compile + copy assets

# Run example Electron app
pnpm dev:example

# Lint and format (uses oxlint/oxfmt, not eslint/prettier)
pnpm lint                  # oxlint packages/*/src
pnpm fmt                   # oxfmt --write packages/*/src
pnpm fmt:check             # oxfmt --check packages/*/src

# Type checking (skips native package which has no TS source)
pnpm typecheck
```

### Native Addon Build Prerequisites

**macOS:** Build Syphon.framework from the git submodule:
```bash
cd vendor/syphon-src
xcodebuild -project Syphon.xcodeproj -scheme Syphon -configuration Release \
  -derivedDataPath build ONLY_ACTIVE_ARCH=NO BUILD_LIBRARY_FOR_DISTRIBUTION=YES
cp -R build/Build/Products/Release/Syphon.framework ../Syphon.framework
```

**Windows:** Clone Spout2 SDK into vendor (directory structure must be preserved for relative includes):
```bash
git clone --depth 1 https://github.com/leadedge/Spout2.git _tmp
mkdir -p vendor/Spout2
cp -r _tmp/SPOUTSDK/SpoutDirectX vendor/Spout2/SpoutDirectX
cp -r _tmp/SPOUTSDK/SpoutGL vendor/Spout2/SpoutGL
rm -rf _tmp
```

## Architecture: Data Flow

```
OffscreenBrowserWindow (useSharedTexture: true)
  → WebGL/Canvas rendering in Web Worker
  → paint event fires with textureInfo (IOSurface / NT Handle)
  → TextureSender.send() / sendSurface() — zero-copy GPU share
  → Syphon Server (macOS) or Spout Sender (Windows)
  → External VJ apps receive texture
```

The key insight: Electron 40's `sharedTexture` paint event provides a GPU texture handle directly — the native addon passes this handle to Syphon/Spout without ever reading pixels back to CPU.

## Native Addon Layering

```
JavaScript API (packages/native/src/lib.rs via napi-rs)
  → Platform module (src/mac/mod.rs or src/win/mod.rs)
    → FFI declarations (src/mac/ffi.rs or src/win/ffi.rs)
      → C++/ObjC++ bridge (cpp/mac/syphon_bridge.mm or cpp/win/spout_bridge.cpp)
        → Vendor SDK (Syphon.framework or SpoutDX)
```

`build.rs` resolves `vendor/` paths relative to workspace root (two directories up from `packages/native/Cargo.toml` via `CARGO_MANIFEST_DIR`). The `cpp/` directory is crate-root relative since Cargo sets CWD to `packages/native/`.

## Core Package API

`sendTextureFromPaintEvent(sender, textureInfo)` is the main convenience function. It handles platform differences:
- **macOS:** Reads `handle.ioSurface` buffer → calls `sender.sendSurface()`
- **Windows:** Reads `handle.ntHandle` buffer as BigInt64LE → calls `sender.send()`

Three send methods exist at the native level:
- `sendSurface()` — IOSurface pointer (macOS, zero-copy)
- `send()` — DXGI/NT handle (Windows, zero-copy)
- `sendRgbaBuffer()` — raw pixel data fallback (both platforms, involves CPU copy)

## Renderer Package API

`createTextureBridge(options)` is the main entry point for most users (main process):
- Creates offscreen BrowserWindow with `useSharedTexture`
- Instantiates `TextureSender` (Syphon/Spout)
- Wires paint event → `sendTextureFromPaintEvent()` + preview
- Returns `TextureBridge` handle with `on('fps')`, `resize()`, `openPreview()`, `dispose()`

Sub-exports:
- `@napolab/texture-bridge-renderer/client` — `createWorkerRenderer()` for renderer process (canvas → OffscreenCanvas → Worker, with ResizeObserver)
- `@napolab/texture-bridge-renderer/worker` — `WorkerMessage` types for type-safe worker communication

## Key Technical Constraints

- Electron 40.0.0+ required for `useSharedTexture` paint events
- macOS: Metal only (no OpenGL), requires macOS 10.15+
- Windows: Direct3D 11, DXGI 1.2+, Windows 10+
- The `release()` callback on paint textures must be called to prevent GPU memory leaks
- napi-rs `binaryName` is `texture-bridge`, generating files like `texture-bridge.darwin-arm64.node`

## Release (release-please)

- Uses `release-please` with `linked-versions` plugin — all three packages share the same version
- Config: `release-please-config.json`, manifest: `.release-please-manifest.json`
- **Path-based detection:** release-please only creates a release PR when Conventional Commits (`fix:`, `feat:`, etc.) touch files **inside** a configured package path (`packages/native/`, `packages/core/`, `packages/renderer/`). Changes to root-level files (`.github/workflows/ci.yml`, root `package.json`, etc.) are **ignored** and will not trigger a release PR.
- To trigger a release for CI-only or root-level fixes, make a change (e.g. bump comment or changelog entry) inside one of the package directories, or create the release PR manually.

## Workflow: Before Starting Implementation

Before writing any new code, check [`tasks.md`](tasks.md) for pending implementation plans. Each task links to a detailed plan document in `docs/superpowers/plans/`. If the work you're about to do is already planned there, follow the existing plan rather than designing from scratch.

## Tooling Notes

- **TypeScript:** Uses `tsgo` (native TS compiler preview) for type checking, `tsdown` for bundling core
- **Linting/Formatting:** `oxlint` and `oxfmt` (Rust-based, not eslint/prettier)
- **Example app:** `electron-vite` for dev/build, `electron-builder` for packaging
- **CI:** GitHub Actions builds on macOS-14 (ARM), macOS-13 (x64), Windows (MSVC). Publishes on version tags.
