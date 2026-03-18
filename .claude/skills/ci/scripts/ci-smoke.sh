#!/usr/bin/env bash
# ci-smoke.sh — Reproduce CI workflow locally
# Usage: bash ci-smoke.sh [--skip-common] [--skip-native] [--skip-package]
set -euo pipefail

# ── Argument parsing ──────────────────────────────────────────────
SKIP_COMMON=false
SKIP_NATIVE=false
SKIP_PACKAGE=false

for arg in "$@"; do
  case "$arg" in
    --skip-common)  SKIP_COMMON=true ;;
    --skip-native)  SKIP_NATIVE=true ;;
    --skip-package) SKIP_PACKAGE=true ;;
    --help|-h)
      echo "Usage: ci-smoke.sh [--skip-common] [--skip-native] [--skip-package]"
      echo "  --skip-common   Skip lint/typecheck/build steps"
      echo "  --skip-native   Skip cargo test and native addon build"
      echo "  --skip-package  Skip electron-builder packaging and verification"
      exit 0
      ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# ── Platform detection ────────────────────────────────────────────
PLATFORM=$(uname -s)
PROJECT_ROOT=$(git rev-parse --show-toplevel)
cd "$PROJECT_ROOT"

echo "========================================"
echo " CI Local Smoke Test"
echo " Platform: $PLATFORM"
echo " Root:     $PROJECT_ROOT"
echo "========================================"
echo ""

STEP=0
step() {
  STEP=$((STEP + 1))
  echo "── [$STEP] $1 ──"
}

# ── Common checks (all platforms) ─────────────────────────────────
if [ "$SKIP_COMMON" = false ]; then
  step "pnpm lint"
  pnpm lint

  step "pnpm build:core"
  pnpm build:core

  step "pnpm build:renderer"
  pnpm build:renderer

  step "pnpm typecheck"
  pnpm typecheck

  echo ""
  echo ">> Common checks passed"
  echo ""
else
  echo ">> Skipping common checks (--skip-common)"
  echo ""
fi

# ── Platform-specific native smoke ────────────────────────────────
case "$PLATFORM" in
  Darwin)
    echo "========================================"
    echo " macOS Native Smoke"
    echo "========================================"
    echo ""

    # Vendor SDK check
    if [ ! -d "$PROJECT_ROOT/vendor/Syphon.framework" ]; then
      echo "ERROR: vendor/Syphon.framework not found."
      echo ""
      echo "Build it:"
      echo "  cd vendor/syphon-src"
      echo "  xcodebuild -project Syphon.xcodeproj -scheme Syphon \\"
      echo "    -configuration Release -derivedDataPath build \\"
      echo "    ONLY_ACTIVE_ARCH=NO BUILD_LIBRARY_FOR_DISTRIBUTION=YES"
      echo "  cp -R build/Build/Products/Release/Syphon.framework ../Syphon.framework"
      exit 1
    fi

    if [ "$SKIP_NATIVE" = false ]; then
      step "cargo test (native)"
      cargo test --manifest-path packages/native/Cargo.toml

      step "pnpm build:native"
      pnpm build:native

      step "Example typecheck"
      pnpm --filter @napolab/texture-bridge-example typecheck

      step "Example build"
      pnpm --filter @napolab/texture-bridge-example build

      echo ""
      echo ">> Native build passed"
      echo ""
    else
      echo ">> Skipping native build (--skip-native)"
      echo ""
    fi

    if [ "$SKIP_PACKAGE" = false ]; then
      step "electron-builder --dir --mac"
      (cd packages/example && pnpm exec electron-builder --dir --mac)

      step "Verify packaged artifacts"
      ARCH=$(uname -m)
      if [ "$ARCH" = "arm64" ]; then
        APP_DIR="packages/example/dist/mac-arm64"
        NODE_FILE="index.darwin-arm64.node"
      else
        APP_DIR="packages/example/dist/mac"
        NODE_FILE="index.darwin-x64.node"
      fi

      test -f "$APP_DIR/TextureBridgeExample.app/Contents/Frameworks/Syphon.framework/Versions/A/Syphon" \
        || { echo "FAIL: Syphon.framework not found in package"; exit 1; }
      test -f "$APP_DIR/TextureBridgeExample.app/Contents/Resources/app.asar.unpacked/node_modules/@napolab/texture-bridge/$NODE_FILE" \
        || { echo "FAIL: Native addon not found in package"; exit 1; }

      echo ">> All macOS artifacts verified"
      echo ""
    else
      echo ">> Skipping packaging (--skip-package)"
      echo ""
    fi
    ;;

  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    echo "========================================"
    echo " Windows Native Smoke"
    echo "========================================"
    echo ""

    # Vendor SDK check
    if [ ! -d "$PROJECT_ROOT/vendor/Spout2" ]; then
      echo "ERROR: vendor/Spout2 not found."
      echo ""
      echo "Fetch it:"
      echo "  git clone --depth 1 https://github.com/leadedge/Spout2.git _tmp"
      echo "  mkdir -p vendor/Spout2"
      echo "  cp -r _tmp/SPOUTSDK/SpoutDirectX vendor/Spout2/SpoutDirectX"
      echo "  cp -r _tmp/SPOUTSDK/SpoutGL vendor/Spout2/SpoutGL"
      echo "  rm -rf _tmp"
      exit 1
    fi

    if [ "$SKIP_NATIVE" = false ]; then
      step "cargo test (native)"
      cargo test --manifest-path packages/native/Cargo.toml

      step "pnpm build:native"
      pnpm build:native

      step "Example typecheck"
      pnpm --filter @napolab/texture-bridge-example typecheck

      step "Example build"
      pnpm --filter @napolab/texture-bridge-example build

      echo ""
      echo ">> Native build passed"
      echo ""
    else
      echo ">> Skipping native build (--skip-native)"
      echo ""
    fi

    if [ "$SKIP_PACKAGE" = false ]; then
      step "electron-builder --dir --win"
      (cd packages/example && pnpm exec electron-builder --dir --win)

      step "Verify packaged artifacts"
      APP_ROOT="packages/example/dist/win-unpacked/resources"
      test -f "$APP_ROOT/app.asar.unpacked/node_modules/@napolab/texture-bridge/index.win32-x64-msvc.node" \
        || { echo "FAIL: Native addon not found in package"; exit 1; }

      echo ">> All Windows artifacts verified"
      echo ""
    else
      echo ">> Skipping packaging (--skip-package)"
      echo ""
    fi
    ;;

  Linux)
    echo "========================================"
    echo " Linux (common checks only)"
    echo "========================================"
    echo ""
    echo "Native build is not supported on Linux."
    echo "Common checks have already been executed above."
    echo ""
    ;;

  *)
    echo "ERROR: Unknown platform: $PLATFORM"
    exit 1
    ;;
esac

echo "========================================"
echo " CI smoke test complete"
echo "========================================"
