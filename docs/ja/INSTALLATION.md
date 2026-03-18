# インストールガイド

electron-texture-bridge を**ライブラリとして利用する**場合と、**ソースからビルドして開発に参加する**場合の両方を網羅した詳細なガイドです。

## 目次

- [クイックインストール (npm)](#クイックインストール-npm)
- [前提条件](#前提条件)
  - [全プラットフォーム共通](#全プラットフォーム共通)
  - [macOS](#macos)
  - [Windows](#windows)
- [ソースからのビルド](#ソースからのビルド)
  - [1. リポジトリのクローン](#1-リポジトリのクローン)
  - [2. ベンダー SDK の準備](#2-ベンダー-sdk-の準備)
  - [3. 依存関係のインストールとビルド](#3-依存関係のインストールとビルド)
  - [4. サンプルアプリの実行](#4-サンプルアプリの実行)
- [Electron アプリへの統合](#electron-アプリへの統合)
  - [プロジェクトのセットアップ](#プロジェクトのセットアップ)
  - [メインプロセス (高レベル API)](#メインプロセス-高レベル-api)
  - [メインプロセス (低レベル API)](#メインプロセス-低レベル-api)
  - [レンダラープロセス](#レンダラープロセス)
  - [Web Worker](#web-worker)
- [配布用パッケージング](#配布用パッケージング)
  - [electron-builder](#electron-builder)
  - [electron-forge](#electron-forge)
  - [macOS: Syphon.framework のバンドル](#macos-syphonframework-のバンドル)
- [インストールの検証](#インストールの検証)
- [トラブルシューティング](#トラブルシューティング)

---

## クイックインストール (npm)

プリビルドバイナリが npm に公開されている場合、以下だけで完了します：

```bash
# 推奨: 高レベル API (core + native を含む)
npm install @napolab/texture-bridge-renderer
# または
pnpm add @napolab/texture-bridge-renderer
```

ファクトリを使わずパイプラインを直接制御したい場合：

```bash
npm install @napolab/texture-bridge-core
```

> **Note:** プリビルドのネイティブバイナリは `optionalDependencies` で自動解決されます。npm からのインストールでは Rust ツールチェーンは不要です。

---

## 前提条件

### 全プラットフォーム共通

| ツール | バージョン | 確認方法 | インストール |
|--------|-----------|---------|------------|
| **Node.js** | 20+ | `node -v` | [nodejs.org](https://nodejs.org/) |
| **pnpm** | 10+ | `pnpm -v` | `corepack enable && corepack prepare pnpm@latest --activate` |
| **Rust** | stable (1.75+) | `rustc --version` | [rustup.rs](https://rustup.rs/) |
| **Electron** | 40.0.0+ | `npx electron -v` | プロジェクト依存関係としてインストール |

#### Node.js のインストール

バージョン管理には [fnm](https://github.com/Schniz/fnm) または [volta](https://volta.sh/) を推奨します：

```bash
# fnm
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 22
fnm use 22

# または volta
curl https://get.volta.sh | bash
volta install node@22
```

#### pnpm のインストール

モノレポワークスペースのために pnpm 10+ が必要です：

```bash
# corepack 経由 (推奨、Node.js 16.13+ に同梱)
corepack enable
corepack prepare pnpm@latest --activate

# 確認
pnpm -v
```

#### Rust のインストール

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 確認
rustc --version
cargo --version
```

Windows の場合は [rustup-init.exe](https://rustup.rs/) をダウンロードして実行してください。

### macOS

| 要件 | バージョン | 確認方法 |
|------|-----------|---------|
| **macOS** | 11.0+ (Big Sur) | `sw_vers` |
| **Xcode CLI Tools** | 最新版 | `xcode-select -p` |
| **Metal** | GPU サポート必須 | 2012年以降の全 Mac |

```bash
# Xcode Command Line Tools のインストール
xcode-select --install

# 確認
clang --version
xcodebuild -version
```

クロスコンパイル（例: Apple Silicon で Intel 向けビルド）が必要な場合：

```bash
# x86_64 Rust ターゲットを追加
rustup target add x86_64-apple-darwin
```

### Windows

| 要件 | バージョン | 確認方法 |
|------|-----------|---------|
| **Windows** | 10+ (ビルド 19041+) | `winver` |
| **VS Build Tools** | 2019+ | 下記参照 |
| **Windows SDK** | 10.0.19041.0+ | VS に同梱 |
| **DirectX 11** | GPU サポート必須 | 2010年以降のほぼ全 GPU |

#### Visual Studio Build Tools のインストール

1. [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) をダウンロード
2. インストーラーで **「C++ によるデスクトップ開発」** を選択
3. 以下のコンポーネントがチェックされていることを確認：
   - MSVC v143 - VS 2022 C++ x64/x86 ビルドツール
   - Windows 10/11 SDK (10.0.19041.0 以降)

`winget` を使う方法：

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

確認：

```powershell
# Developer Command Prompt を開く
cl.exe
# MSVC バージョンが表示されれば OK
```

---

## ソースからのビルド

### 1. リポジトリのクローン

```bash
# サブモジュール (Syphon ソース) を含めてクローン
git clone --recursive https://github.com/naporin0624/electron-texture-bridge.git
cd electron-texture-bridge
```

`--recursive` を付けずにクローンしてしまった場合：

```bash
git submodule update --init --recursive
```

サブモジュールの確認：

```bash
ls vendor/syphon-src/Syphon.xcodeproj
# Xcode プロジェクトファイルが表示されれば OK
```

### 2. ベンダー SDK の準備

ネイティブアドオンのビルドには `vendor/` ディレクトリ内にプラットフォーム固有の SDK が必要です。現在のプラットフォーム用のみセットアップすれば OK です。

#### macOS: Syphon.framework のビルド

git サブモジュールから Syphon Metal フレームワークをビルドします：

```bash
cd vendor/syphon-src

xcodebuild -project Syphon.xcodeproj \
  -scheme Syphon \
  -configuration Release \
  -derivedDataPath build \
  ONLY_ACTIVE_ARCH=NO \
  BUILD_LIBRARY_FOR_DISTRIBUTION=YES

# ビルドしたフレームワークを vendor/ にコピー
cp -R build/Build/Products/Release/Syphon.framework ../Syphon.framework

cd ../..
```

確認：

```bash
ls vendor/Syphon.framework/Syphon
# フレームワークバイナリが表示されれば OK

# Gatekeeper の検疫属性をクリア（「未確認の開発元」エラーを防止）
xattr -dr com.apple.quarantine vendor/Syphon.framework
```

> **Tip:** `xcodebuild` が失敗する場合、Xcode ライセンスを承認しているか確認してください：`sudo xcodebuild -license accept`

#### Windows: Spout2 SDK の取得

Spout2 リポジトリから SpoutDX ソースファイルをダウンロードします：

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

確認：

```bash
ls vendor/SpoutDX/SpoutDX.h
# ヘッダファイルが表示されれば OK
```

### 3. 依存関係のインストールとビルド

```bash
# ワークスペース全体の依存関係をインストール
pnpm install

# 全パッケージをビルド (native addon -> core -> renderer)
pnpm build
```

以下の順序で実行されます：
1. **`pnpm build:native`** — napi-rs 経由で Rust ネイティブアドオンをコンパイル。`.node` ファイルを生成（例：`texture-bridge.darwin-arm64.node`）
2. **`pnpm build:core`** — TypeScript core パッケージをバンドル（CJS + ESM）
3. **`pnpm build:renderer`** — TypeScript renderer パッケージをバンドル（CJS + ESM）し、静的アセットをコピー

個別パッケージのビルド：

```bash
pnpm build:native     # ネイティブアドオンのみ
pnpm build:core       # core パッケージのみ
pnpm build:renderer   # renderer パッケージのみ
```

### 4. サンプルアプリの実行

```bash
pnpm dev:example
```

Three.js レイマーチング VJ デモが起動します：
- 1920x1080 / 120fps でオフスクリーンレンダリング
- Syphon/Spout 出力名：「ElectronVJ-ThreeJS」
- WebGPU プレビューウィンドウ (960x540)

Syphon/Spout レシーバーアプリを開いて **「ElectronVJ-ThreeJS」** を確認してください。

---

## Electron アプリへの統合

### プロジェクトのセットアップ

```bash
# 新しい Electron プロジェクトを作成（既存のものでも OK）
mkdir my-vj-app && cd my-vj-app
pnpm init
pnpm add electron@latest @napolab/texture-bridge-renderer
```

Electron のバージョンが 40.0.0+ であることを確認：

```bash
npx electron -v
# v40.x.x 以上が出力されれば OK
```

### メインプロセス (高レベル API)

全ボイラープレートを処理するファクトリ API が推奨です：

```typescript
// src/main.ts
import { app, BrowserWindow, globalShortcut } from "electron";
import path from "path";
import { createTextureBridge } from "@napolab/texture-bridge-renderer";

app.whenReady().then(async () => {
  const bridge = await createTextureBridge({
    name: "MyVJApp",             // Syphon/Spout サーバー名
    width: 1920,
    height: 1080,
    frameRate: 60,
    rendererUrl: path.join(__dirname, "renderer/index.html"),
    preview: {
      enabled: true,             // WebGPU プレビューウィンドウを開く
      width: 960,
      height: 540,
    },
  });

  // FPS モニタリング
  bridge.on("fps", (fps) => {
    console.log(`FPS: ${fps.toFixed(1)}`);
  });

  // エラーハンドリング
  bridge.on("error", (err) => {
    console.error("Bridge error:", err.message);
  });

  // 動的リサイズ
  // bridge.resize(3840, 2160);

  // 終了時のクリーンアップ
  app.on("before-quit", () => {
    bridge.dispose();
  });
});

app.on("window-all-closed", () => app.quit());
```

### メインプロセス (低レベル API)

パイプラインを完全に制御する場合：

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
    texture.release?.(); // 重要: GPU メモリリークを防ぐため必ず release を呼ぶ
  }
});

win.webContents.setFrameRate(60);
win.loadFile("renderer/index.html");
```

### レンダラープロセス

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

または、自動リサイズ伝播付きのレンダラーヘルパーを使用：

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
      // リソースのクリーンアップ
      break;
  }
};

function render() {
  // レンダリングロジック
  ctx.fillStyle = `hsl(${Date.now() % 360}, 100%, 50%)`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  requestAnimationFrame(render);
}
```

---

## 配布用パッケージング

### electron-builder

`electron-builder.yml`（または同等の設定）に以下を追加：

```yaml
asarUnpack:
  - node_modules/@napolab/texture-bridge*

# macOS: Syphon.framework をバンドル
mac:
  extraFiles:
    - from: path/to/Syphon.framework
      to: Frameworks/Syphon.framework
```

`asarUnpack` はネイティブ `.node` アドオンが ASAR アーカイブ内から読み込めないため必須です。

### electron-forge

`forge.config.js` に設定：

```javascript
module.exports = {
  packagerConfig: {
    asar: {
      unpack: "**/node_modules/@napolab/texture-bridge*/**",
    },
    // macOS: Syphon.framework をコピー
    extraResource: [
      "./node_modules/@napolab/texture-bridge/Syphon.framework",
    ],
  },
};
```

### macOS: Syphon.framework のバンドル

macOS アプリを配布する場合、`Syphon.framework` はコード署名してアプリバンドルに含める必要があります。ネイティブアドオンの `build.rs` は `@executable_path/../Frameworks` の rpath を設定済みなので、`YourApp.app/Contents/Frameworks/Syphon.framework` に配置するのが正しいパスです。

コード署名：

```bash
codesign --deep --force --sign "Developer ID Application: Your Name" \
  YourApp.app/Contents/Frameworks/Syphon.framework
```

---

## インストールの検証

### 1. ネイティブアドオンの読み込み確認

```bash
node -e "const n = require('@napolab/texture-bridge'); console.log('Platform:', n.getPlatform())"
```

期待される出力：
- macOS: `Platform: syphon-metal`
- Windows: `Platform: spout`

### 2. Syphon/Spout レシーバーでの確認

1. アプリを起動（またはサンプル：`pnpm dev:example`）
2. Syphon/Spout レシーバーを開く：
   - **macOS:** [Syphon Recorder](http://syphon.v002.info/recorder/)、[Simple Client](http://syphon.v002.info/)、VDMX など
   - **Windows:** [SpoutReceiver](https://spout.zeal.co/)（Spout2 同梱）、Resolume、OBS + Spout プラグイン
3. センダー名（例：「ElectronVJ-ThreeJS」）が一覧に表示されれば成功

### 3. FPS 出力の確認

サンプルアプリは FPS を stdout に出力します：

```
[example] FPS: 59.8
[example] FPS: 60.0
```

FPS が 0 または極端に低い場合は[トラブルシューティング](#トラブルシューティング)を参照してください。

---

## トラブルシューティング

### ビルドエラー

#### `xcodebuild: error: ... Syphon.xcodeproj`

Syphon サブモジュールがクローンされていません：

```bash
git submodule update --init --recursive
```

#### `fatal error: 'SpoutDX.h' file not found`

Spout SDK が取得されていません：

```bash
git clone --depth 1 https://github.com/leadedge/Spout2.git _spout2_tmp
cp -r _spout2_tmp/SPOUTSDK/SpoutDirectX/SpoutDX vendor/SpoutDX
rm -rf _spout2_tmp
```

#### `error: linker 'link.exe' not found` (Windows)

Visual Studio Build Tools がインストールされていないか PATH に通っていません。「C++ によるデスクトップ開発」ワークロードをインストールし、ターミナルを再起動してください。

#### `error[E0463]: can't find crate for 'napi'`

Rust の依存関係が取得されていません：

```bash
cd packages/native
cargo fetch
cd ../..
pnpm build:native
```

#### `error: framework not found Syphon` (macOS)

`vendor/Syphon.framework` が存在しないか、場所が間違っています：

```bash
ls vendor/Syphon.framework/Syphon
# このファイルが存在しない場合、再ビルド：
cd vendor/syphon-src
xcodebuild -project Syphon.xcodeproj -scheme Syphon -configuration Release \
  -derivedDataPath build ONLY_ACTIVE_ARCH=NO BUILD_LIBRARY_FOR_DISTRIBUTION=YES
cp -R build/Build/Products/Release/Syphon.framework ../Syphon.framework
cd ../..
```

### ランタイムエラー

#### `Error: Cannot find module '..../texture-bridge.darwin-arm64.node'`

お使いのプラットフォーム向けにネイティブアドオンがビルドされていません。再ビルドしてください：

```bash
pnpm build:native
```

#### `Error: dlopen ... Syphon ... image not found` (macOS)

Syphon.framework が実行時に見つかりません。`vendor/Syphon.framework` が存在し、検疫属性がクリアされていることを確認：

```bash
xattr -dr com.apple.quarantine vendor/Syphon.framework
```

パッケージ済みアプリの場合、Syphon.framework が `Contents/Frameworks/` にあることを確認してください。

#### paint イベントが発火しない

- `webPreferences` に `offscreen: { useSharedTexture: true }` が設定されているか確認
- `win.webContents.setFrameRate(60)` が呼ばれているか確認
- レンダラー/ワーカー内で `requestAnimationFrame` ループが動いているか確認
- `show: false` でも paint イベントは発火する

#### レシーバーでテクスチャが真っ黒

- ピクセルフォーマットを確認：Chromium は BGRA を出力する。レシーバーが BGRA を期待しているか確認。
- `preserveDrawingBuffer` は**不要**（Chromium のコンポジターが直接読み取る）。
- レンダリングワーカーが目に見える出力を生成しているか確認（プレビューウィンドウをチェック）。

#### GPU メモリリーク / フリーズ

**各 paint イベントの処理後は必ず `texture.release()` を呼んでください。** GPU テクスチャプールは数フレーム分しかありません。release を呼ばないとパイプラインが停止します。

`createTextureBridge()` 使用時は release は自動的に処理されます。低レベル API 使用時は `try/finally` で確実に release を呼びます：

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
