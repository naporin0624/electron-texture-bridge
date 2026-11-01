# electron-texture-bridge

[![CI](https://github.com/naporin0624/electron-texture-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/naporin0624/electron-texture-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)

**Electron と VJ ソフトウェア間で Spout / Syphon Metal を介して双方向に GPU テクスチャを共有する。**

[English](../../README.md)

Electron との双方向 GPU テクスチャ共有のための napi-rs ネイティブアドオンです。Electron のオフスクリーンレンダリング（`useSharedTexture`）からテクスチャを**送信**して VJ ソフトウェアへ渡す、あるいは外部の Syphon/Spout サーバーからテクスチャを**受信**して Electron アプリに取り込む、どちらにも対応します。Resolume Arena、VDMX、OBS、TouchDesigner など、Syphon/Spout 対応のアプリケーションと連携できます。

## インストール

```bash
npm i @napolab/texture-bridge-renderer
# または
pnpm add @napolab/texture-bridge-renderer
```

このパッケージ 1 つで依存チェーン全体（プリビルド済みネイティブバイナリを含む）が入ります。通常はこれだけに依存すれば十分です。

| 用途 | パッケージ | 提供するもの |
|------|-----------|-------------|
| **高レベル（推奨）** | [`@napolab/texture-bridge-renderer`](https://www.npmjs.com/package/@napolab/texture-bridge-renderer) | `createTextureBridge()` — ウィンドウ・paint・センダー・プレビューを全配線 |
| 低レベル（手動 paint ループ） | [`@napolab/texture-bridge-core`](https://www.npmjs.com/package/@napolab/texture-bridge-core) | `TextureSender` + `sendTextureFromPaintEvent()` |
| ネイティブバインディング | [`@napolab/texture-bridge`](https://www.npmjs.com/package/@napolab/texture-bridge) | napi-rs の生クラス（`TextureSender`, `TextureReceiver`） |
| プリビルドバイナリ | `@napolab/texture-bridge-darwin-arm64` 他 | プラットフォーム別 `.node`。`optionalDependencies` で自動解決 |

依存方向: `texture-bridge-renderer` → `texture-bridge-core` → `texture-bridge` → `texture-bridge-<platform>`。

> ソースからのビルド、前提条件の詳細、パッケージング、統合の手順は **[docs/ja/INSTALLATION.md](../../docs/ja/INSTALLATION.md)** を参照してください。

## AI Agent Skills

このリポジトリには、コーディングエージェントにこのライブラリの実際の API 表面を教える **エージェントスキル** が同梱されています。

これらが存在する理由は、texture-bridge をこれらのスキルなしで統合しようとしたモデルが、一貫して実在しない「もっともらしい」API（`publishSharedTexture`、`subscribeFrames`、定義されたことのないオプションオブジェクトなど）をでっち上げるからです。各スキルはこうした実観測された失敗に対してテストファーストで書かれ、エージェントが実際の API を出力するようになることを検証済みです。

### Claude Code（プラグイン）

```
/plugin marketplace add naporin0624/electron-texture-bridge
/plugin install texture-bridge
```

### その他のエージェント（Skills CLI）

Codex、GitHub Copilot、Amp、Cursor、Antigravity など、[skills.sh](https://skills.sh/naporin0624/electron-texture-bridge) 経由で動作します。**1 コマンドにつき 1 スキルをインストールしてください** — 複数を一度に渡しても最初の 1 つしかインストールされません:

```bash
npx skills add naporin0624/electron-texture-bridge@setting-up-texture-bridge
npx skills add naporin0624/electron-texture-bridge@choosing-texture-bridge-api
npx skills add naporin0624/electron-texture-bridge@migrating-to-forward-frames
npx skills add naporin0624/electron-texture-bridge@receiving-shared-textures
npx skills add naporin0624/electron-texture-bridge@managing-frame-forward-lifecycle
npx skills add naporin0624/electron-texture-bridge@delivering-imported-textures
npx skills add naporin0624/electron-texture-bridge@handling-texture-bridge-failures
```

グローバルにインストールする場合は `-g` を付けてください。

> `@skill-name` サフィックスを省略すると、texture-bridge とは無関係なこのリポジトリ自身の内部開発ルール用スキル（`ci`、`smart-commit` など）を含む、リポジトリ内の **すべての** スキルがインストールされます。目的のスキル名を明示してください。

### 各スキルが担う範囲

スキルは会話の文脈から自動的に発火します — 覚えるべきコマンドはありません。

| スキル | 発火する場面 |
|-------|--------------------------|
| `setting-up-texture-bridge` | ライブラリのインストール、Electron アプリへの Syphon/Spout 出力の追加、electron-vite 設定、セットアップ直後の黒画面/崩れた出力 |
| `choosing-texture-bridge-api` | どの API 階層を使うか — simple vs core、`forwardSharedTexture` vs `forwardFrames`、送信経路 vs 受信経路 — および統合計画のレビュー |
| `migrating-to-forward-frames` | `capturePage` ポーリング / bitmap-IPC プレビュー / Syphon ループバックをゼロコピー転送に置き換える |
| `receiving-shared-textures` | 受信側: 転送されたフレームの消費、マルチビューアグリッド、`VideoFrame` のライフサイクル、切断後にフレームが再表示される問題 |
| `managing-frame-forward-lifecycle` | `forwardFrames` ターゲットの登録・解除: 開閉を繰り返すモニターウィンドウ、繰り返される接続/切断、`MaxListenersExceededWarning`、転送まわりのリーク |
| `delivering-imported-textures` | main からレンダラーへのテクスチャ配送: `importSharedTexture` / `sendSharedTexture` / `release()` を手動で扱う、`release()` をどこに置くべきか、`sendImportedTexture` vs `forwardSharedTexture` |
| `handling-texture-bridge-failures` | エラーハンドリングとテレメトリ: どの呼び出しが throw/reject するか、defect としてモデル化されるか、emit されるか — `Result.fromThrowable` で何を包むべきか、無音の黒画面、ブリッジ呼び出しによる main プロセスのクラッシュ |

## クイックスタート

### 送信: Electron → VJ ソフトウェア

ファクトリがオフスクリーンウィンドウの作成、paint イベントの接続、Syphon/Spout センダー、オプションのプレビューウィンドウをすべて 1 回の呼び出しで処理します。

```typescript
// メインプロセス
import { app } from "electron";
import { createTextureBridge } from "@napolab/texture-bridge-renderer";

app.whenReady().then(async () => {
  const bridge = await createTextureBridge({
    name: "MyApp",
    width: 1920,
    height: 1080,
    frameRate: 60,
    rendererUrl: "path/to/index.html",  // Web Worker を含むレンダラーページ
    preview: { enabled: true },
  });

  bridge.on("fps", (fps) => console.log(`FPS: ${fps.toFixed(1)}`));
  bridge.resize(3840, 2160);  // 全レイヤーを自動リサイズ
  // bridge.dispose();         // 終了時にクリーンアップ
});
```

```html
<!-- レンダラーページ (index.html) -->
<canvas id="canvas" width="1920" height="1080"></canvas>
<script type="module">
  import MyWorker from './my-worker?worker';
  const canvas = document.getElementById('canvas');
  const offscreen = canvas.transferControlToOffscreen();
  const worker = new MyWorker();
  worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
</script>
```

外部ページのライブキャプチャ、透過（`includeAlpha`）、低レベル core の paint ループ、DPI の正確な扱い、electron-vite（ESM）統合など、送信に関するさらなるレシピは **[docs/ja/SENDING.md](../../docs/ja/SENDING.md)** にあります。

### 受信: VJ ソフトウェア → Electron

外部の Syphon/Spout サーバーからテクスチャを取得して Electron アプリに取り込みます。

```typescript
// メインプロセス
import { app } from "electron";
import { createTextureReceiver, SenderDiscovery } from "@napolab/texture-bridge-renderer";

app.whenReady().then(() => {
  // 利用可能なサーバーを検出
  const discovery = new SenderDiscovery();
  discovery.on("added", (senders) => {
    console.log("New senders:", senders);
  });
  discovery.start(1000); // 1 秒ごとにポーリング

  // 特定のサーバーから受信
  const receiver = createTextureReceiver({
    senderName: "Resolume Arena",
  });

  receiver.on("frame", (frame) => {
    // frame: { data: Buffer, width: number, height: number }
    console.log(`Received ${frame.width}x${frame.height} frame`);
  });

  receiver.on("fps", (fps) => console.log(`Receive FPS: ${fps.toFixed(1)}`));
  receiver.start();

  // クリーンアップ
  // receiver.dispose();
  // discovery.dispose();
});
```

この例は **RGBA readback** 経路を使用しています。**ゼロコピー GPU** 経路（`createSharedTextureReceiver`、`bindSharedTextureReceiver`、レンダラーのコンテキスト分離）については **[docs/ja/RECEIVING.md](../../docs/ja/RECEIVING.md)** を参照してください。

## どの API を使うべきか

```
OSR(useSharedTexture) を Syphon/Spout に出したいだけで、ウィンドウ管理もライブラリに任せたい？
  YES → createTextureBridge()  (@napolab/texture-bridge-renderer)
        BrowserWindow・paint 配線・DPR/pixelExact・プレビュー・FPS まで面倒を見る。まずここから。

自前の BrowserWindow / paint ループに後付けで送信だけ足したい？
  YES → TextureSender + sendTextureFromPaintEvent()  (@napolab/texture-bridge-core)
        DPR の整合は自分で担保する — docs/ja/SENDING.md の「macOS Retina / Windows DPI」を参照。

Electron 無しで生 RGBA を流したい（テスト / CI / サニティチェック）？
  YES → new TextureSender(...).sendRgbaBuffer()  (@napolab/texture-bridge-core)
        docs/ja/SENDING.md の「Electron 無しの最小サニティチェック」を参照。
```

### パッケージの役割と依存方向

```
@napolab/texture-bridge-renderer   高レベルファクトリ API（推奨）: createTextureBridge、
        │                          レシーバー、ディスカバリ、プレビュー
        ▼
@napolab/texture-bridge-core       低レベルプリミティブ: TextureSender / TextureReceiver、
        │                          sendTextureFromPaintEvent — Electron はオプション
        ▼
@napolab/texture-bridge            ネイティブアドオン（napi-rs バインディング）
        │
        ▼
@napolab/texture-bridge-darwin-arm64 / -darwin-x64 / -win32-x64-msvc
                                   プリビルド済みプラットフォームバイナリ（自動インストール）
```

## アーキテクチャ

### 送信 (Electron → VJ ソフトウェア)

```
[Web Worker]              [Chromium GPU Process]         [Native Addon]         [外部アプリ]
 Three.js / WebGL  ──→   Compositor (Metal / D3D11) ──→  texture-bridge  ──→   Resolume Arena
 OffscreenCanvas          Shared Texture (GPU)            Spout / Syphon        VDMX, OBS 等
```

全パイプラインが GPU 上で完結。CPU リードバックなし。サブフレームレイテンシ。

### 受信 (VJ ソフトウェア → Electron)

フレームをどう扱いたいかによって、2 つの経路が選べます:

**RGBA readback（両プラットフォームで動作）:**

```
[External Apps]          [Native Addon]                  [Electron App]
 Resolume Arena   ──→    texture-bridge   ──→ RGBA buf ──→  Process frames
 VDMX, OBS, etc.         Syphon Client / Spout Receiver     Display, analyze, etc.
```

GPU→CPU リードバック（Metal blit / D3D11 staging）に加え、ArrayBuffer の IPC ホップを伴います。JS 側でピクセルを検査する必要がある場合（解析、ディスクへの保存、独自のカラーパイプラインなど）に使用します。

**ゼロコピー GPU 共有テクスチャ（Windows + macOS）:**

```
[External Apps]          [Native Addon]        [Electron main]         [Electron renderer]
 Resolume Arena   ──→   texture-bridge   ──→  importSharedTexture ──→  VideoFrame
 VDMX, OBS, etc.        Shared Handle /       + sendSharedTexture       drawImage / WebGPU
                        IOSurface             (zero-copy GPU)           importExternalTexture
```

テクスチャは送信元から最終的に消費先の canvas や WebGPU デバイスまで、一貫して GPU 上に置かれたまま渡されます。CPU リードバックも IPC でのピクセルコピーもありません — ソースが shared-texture を裏付けとする `VideoFrame` の場合、`drawImage(videoFrame, 0, 0)` は Chromium 内で GPU blit になります。

## 特徴

- **GPU ゼロコピー送信**: IOSurface（macOS）または DXGI Shared Handle（Windows）を介して GPU 上で直接テクスチャを共有
- **GPU ゼロコピー受信**（Windows + macOS）: Electron の `importSharedTexture` を介して、Syphon/Spout サーバーからのテクスチャをレンダラーの `VideoFrame` へ直接取り込み — CPU リードバックも IPC でのピクセルコピーもなし
- **透過キャプチャ**: `includeAlpha: true` によりオフスクリーンウィンドウがピクセル単位のアルファを共有テクスチャへ転送するため、VJ ソフトウェアはオーバーレイ / ロワーサード合成に適した正しい透過を持つレイヤーとして受け取れる
- **RGBA readback 受信**: `TextureReceiver.receiveFrame()` が両プラットフォームでピクセルを `Buffer` として返す
- **センダーディスカバリ**: 利用可能な Syphon サーバー / Spout センダーをリアルタイムの変更イベント付きで列挙
- **クロスプラットフォーム**: macOS は Syphon Metal、Windows は Spout
- **Electron ネイティブ対応**: Electron 40+ の `useSharedTexture` paint イベントと `sharedTexture` モジュール向けに構築
- **WebGPU プレビュー**: `importExternalTexture` を使用したゼロコピープレビューウィンドウ（オプション）
- **ファクトリ API**: 送信用の `createTextureBridge()`、RGBA readback 用の `createTextureReceiver()`、ゼロコピー GPU 配送用の `createSharedTextureReceiver()` — 定型処理をすべて肩代わり
- **低レベル API**: `sendTextureFromPaintEvent()`、`TextureReceiver`、`closeNativeHandle()` による完全な制御
- **napi-rs**: 型安全な Rust → Node.js バインディング（プリビルドバイナリ付き）

## 対応プラットフォーム

| プラットフォーム | プロトコル | GPU API | ターゲット |
|----------|----------|---------|--------|
| macOS (Apple Silicon) | Syphon Metal | IOSurface + Metal | `aarch64-apple-darwin` |
| macOS (Intel) | Syphon Metal | IOSurface + Metal | `x86_64-apple-darwin` |
| Windows x64 | Spout | DXGI Shared Handle + D3D11 | `x86_64-pc-windows-msvc` |

### プラットフォーム別の機能対応

| 機能 | Windows (Spout) | macOS (Syphon Metal) |
|---------|:---------------:|:--------------------:|
| センダー（Electron の paint → 外部アプリ） | 対応 | 対応 |
| レシーバー、RGBA readback（`receiveFrame()`） | 対応 | 対応 |
| レシーバー、ゼロコピー GPU（`receiveSharedTexture()` + `createSharedTextureReceiver`） | 対応 | 対応 |
| センダーディスカバリ（`listSenders()` / `SenderDiscovery`） | 対応 | 対応 |
| 透過キャプチャ（`createTextureBridge({ includeAlpha: true })`） | 対応 | 対応 |

## 必要要件

- **Node.js** 20+
- **Electron** 40.0.0+
- **macOS** 11.0+（Metal）、または DirectX 11 対応 GPU を搭載した **Windows**

ソースからビルドする場合はさらに Rust ツールチェーン、pnpm 10+、各プラットフォームのビルドツールが必要です — [docs/ja/INSTALLATION.md § 前提条件](../../docs/ja/INSTALLATION.md#前提条件) を参照してください。

## パフォーマンス

### 送信

| パス | GPU コピー | レイテンシ | メモリ |
|------|-----------|---------|--------|
| Syphon / Spout | 0（ゼロコピー） | 1 フレーム未満 | 共有 GPU メモリ |
| WebGPU プレビュー | 0（ゼロコピー） | 1 フレーム未満 | 共有 GPU メモリ |
| RGBA バッファ（フォールバック） | 1（CPU → GPU） | 2-3 フレーム | CPU + GPU |

### 受信

| パス | GPU コピー | IPC コピー | レイテンシ | 備考 |
|------|-----------|----------|---------|-------|
| Shared Texture（`createSharedTextureReceiver` / `receiveSharedTexture`） | 0（ゼロコピー） | なし（ハンドルのみ） | 1 フレーム未満 | Windows + macOS。フレームは `VideoFrame` として届く — `drawImage` または WebGPU の `importExternalTexture` を使用 |
| RGBA Readback（`createTextureReceiver` / `receiveFrame`） | 1（GPU → CPU staging） | 1080p 1 フレームあたり約 8 MB | 2–3 フレーム | JS 側で実際にピクセルデータが必要な場合に使用 |

60fps でのおおよその readback 帯域: 1080p で約 500 MB/s、4K で約 2 GB/s — 表示のみのワークロードでは、ポーリング頻度を下げるか shared-texture 経路への切り替えを検討してください。

## サンプルアプリケーション

`packages/example/` ディレクトリに以下を実装した VJ アプリケーションが含まれています：

- **Three.js + GLSL レイマーチング**: OffscreenCanvas Web Worker 内でのレンダリング
- **SDF ベースの 3D ビジュアル**: オーディオリアクティブなパラメータ制御
- **WebGPU プレビューウィンドウ**: GPU ゼロコピーテクスチャ表示
- **Syphon/Spout 出力**: プロフェッショナル VJ ソフトウェアとの統合

```bash
# サンプルアプリの実行
pnpm dev:example
```

Syphon/Spout レシーバーアプリで「ElectronVJ-ThreeJS」が表示されれば成功です。

### Multi-Receiver Grid（マルチビューア）

サンプルには、`forwardFrames` をエンドツーエンドで実演するもう 1 つのウィンドウも含まれています。**デッキ 4 面**（480×270 のキャンバス）と **2×2 の合成プレビュー**（960×540）で、最大 4 ソースを同時に監視できます。各デッキは 2 つの経路のどちらかを個別に割り当て可能です:

- **`[local]`** — 自プロセス内の bridge を `bridge.forwardFrames(multiviewerWindow.webContents, { extraArgs: [slot] })` で転送する経路。この機能で新たに追加された、ゼロコピーの renderer→renderer 経路の実証です。
- **`[syphon]`** — 既存の `createSharedTextureReceiver({ senderName, target, extraArgs: [slot] })` で外部 Syphon/Spout sender を受信する経路。

同じソースを両方の経路に同時に割り当てることもでき（一方は直接転送、もう一方は Syphon/Spout を経由した往復）、その場で挙動を比較できます。外部 sender がなくても 4 スロットすべて埋まるよう、ローカルソースを 4 本標準で用意しています: サンプル本体の `ElectronVJ-ThreeJS`（レイマーチング）bridge に加え、色相違いの軽量な `Grid-Demo-A/B/C` bridge（960×540・30fps）3 本です。マルチビューアだけを手早く確認したい場合は、重い VJ bridge と receiver-test ウィンドウを省く `pnpm --filter @napolab/texture-bridge-example dev:multiviewer`（`MULTIVIEWER_ONLY=1 electron-vite dev` 相当）で起動できます — グリッドは `Grid-Demo-*` の 3 本だけで埋まります。

各デッキは直近に到着した 1 フレームのみを保持し、`requestAnimationFrame` ループが毎ティック、保持中のフレームをデッキキャンバスと合成キャンバスの該当象限へ描画します。そのため描画コストはディスプレイのリフレッシュレートに固定され、接続スロット数や各ソースの fps には比例しません。到着 fps（`onFrame` の呼び出し頻度）と描画 fps（`rAF` での実描画頻度）はデッキごとに分けて計測・表示します — ソースの fps とディスプレイのリフレッシュレートが一致しない場合、両者は乖離するためです。

合成キャンバス自体が「renderer 側のアトラス」であり、4 ソースを転送前に GPU 上で 1 枚のテクスチャへアトラス化することはあえてしていません。アトラス化で節約できるのはフレームあたり数回の import/IPC 呼び出しだけ（この規模ではボトルネックになりません）で、代わりに main プロセス側の合成パスと 1 フレーム分の遅延が必要になり、低レイテンシなマルチビューアという目的には本末転倒だからです。

### サンプルアプリのパッケージング

```bash
# macOS
pnpm --filter @napolab/texture-bridge-example run build:mac

# Windows
pnpm --filter @napolab/texture-bridge-example run build:win
```

> **自分のアプリのパッケージング。** ネイティブ `.node` アドオンは ASAR アーカイブ内からロードできないため、electron-builder 設定に `asarUnpack: "node_modules/@napolab/texture-bridge*"` を追加し、macOS では `Syphon.framework` を `Frameworks/` に同梱して codesign してください。コピペできる electron-builder / electron-forge のスニペットは [docs/ja/INSTALLATION.md](../../docs/ja/INSTALLATION.md) にあります。

## ドキュメント

| ドキュメント | 内容 |
|----------|--------------|
| [docs/ja/INSTALLATION.md](../../docs/ja/INSTALLATION.md) | 前提条件、ソースからのビルド、アプリへの統合、パッケージング、検証 |
| [docs/ja/SENDING.md](../../docs/ja/SENDING.md) | 外部ページのキャプチャ、`includeAlpha` による透過、低レベル core の paint ループ、Retina/DPI の正確な扱い、Electron 無しのサニティチェック、electron-vite（ESM） |
| [docs/ja/RECEIVING.md](../../docs/ja/RECEIVING.md) | 2 つの受信経路、`createSharedTextureReceiver`、`bindSharedTextureReceiver` / `receiver.consume`、ハンドルの所有権、レンダラーのコンテキスト分離 |
| [docs/ja/API.md](../../docs/ja/API.md) | 3 パッケージすべてのエクスポートシンボルの完全な API リファレンス |
| [docs/ja/TROUBLESHOOTING.md](../../docs/ja/TROUBLESHOOTING.md) | 黒画面、paint イベントが発火しない、フリーズ、プラットフォームごとのレシーバー問題 |
| [docs/ja/MIGRATION.md](../../docs/ja/MIGRATION.md) | Electron 42 / OSR デバイススケール、同期的な dispose（v0.14+）、明示的な破棄（v0.6+） |
| [docs/ja/DEVELOPMENT.md](../../docs/ja/DEVELOPMENT.md) | リポジトリ構成と CI |
| [docs/ja/ARCHITECTURE.md](../../docs/ja/ARCHITECTURE.md) | 現在のアーキテクチャの Mermaid 図: パッケージとプロセスの対応、送信経路、受信経路とハンドルの所有権、`forwardFrames` のファンアウト、ネイティブのレイヤーとスレッド |

## ライセンス

[MIT](../../LICENSE)
