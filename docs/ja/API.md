# API リファレンス

エクスポートされるすべてのシンボルの完全なリファレンスです。ガイド付きの導入は [README](../../lang/ja/README.md)、送信のレシピは [SENDING.md](SENDING.md)、受信経路は [RECEIVING.md](RECEIVING.md) を参照してください。

## `@napolab/texture-bridge-renderer`

### `createTextureBridge(options): Promise<TextureBridge>`

完全に接続されたテクスチャブリッジを作成するファクトリ関数。`app.whenReady()` の後に呼び出す必要があります。

```typescript
interface TextureBridgeOptions {
  name: string;            // Syphon/Spout センダー名
  width: number;           // テクスチャ幅（ピクセル）
  height: number;          // テクスチャ高さ（ピクセル）
  frameRate?: number;      // 目標フレームレート（デフォルト: 60）
  rendererUrl: string;     // 読み込む URL（ファイルパス、file://、http://）
  preview?: PreviewOptions;
  webPreferences?: Electron.WebPreferences;
  includeAlpha?: boolean;  // ページのピクセル単位のアルファを共有テクスチャへ転送する（デフォルト: false）
  pixelExact?: boolean;    // ディスプレイ DPR に関係なくフレームバッファを正確に width×height に固定する（デフォルト: false）
}

interface PreviewOptions {
  enabled?: boolean;       // プレビューウィンドウを開く（デフォルト: false）
  width?: number;          // プレビューウィンドウ幅
  height?: number;         // プレビューウィンドウ高さ
  title?: string;          // プレビューウィンドウタイトル
}
```

**`pixelExact`** — `true` のとき、ホストディスプレイの DPR に関係なくオフスクリーンフレームバッファを正確に `width × height` ピクセルに固定します。**Electron ≥ 41:** 自明に満たされ実質的に no-op です — `createTextureBridge` がすでに `offscreen.deviceScaleFactor: 1` を固定しているため、このオプションの有無に関わらずフレームバッファは常に正確です。**Electron 40:** 指定しないと Retina（scaleFactor 2）や Windows スケーリング（150% / 175%）のディスプレイでは宣言したセンダーサイズより大きいフレームバッファが生成され、多くの場合レシーバーで黒画面/崩れになります（[Retina/DPI 警告](SENDING.md#macos-retina-と-windows-dpi-スケーリング-macos-retina-and-windows-dpi-scaling)参照）。センダーは常に要求ピクセルサイズで登録されるため、レシーバーは指定どおりの寸法を受け取ります。注意: 割り切れないスケール比（例: `1920 / 1.75`）では 1 ピクセルの誤差が残ることがあり、構築時のプライマリディスプレイの scaleFactor のみが反映されます — DPI 変更後は `resize()` で再適用してください。

### `createTextureBridgeWith(deps)`（上級者向け）

```typescript
interface TextureBridgeDeps {
  createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
  createSender: (name: string, width: number, height: number) => TextureSender;
}

function createTextureBridgeWith(
  deps: TextureBridgeDeps,
): (options: TextureBridgeOptions) => Promise<TextureBridge>;
```

注入されたコンストラクタに束縛された `createTextureBridge` を返します —
テストや組み込み側が `BrowserWindow` の構築や、ネイティブ `TextureSender` の
構築をテストダブルに差し替えられるようにするためのものです。
`createTextureBridge` 自体も、実際の `BrowserWindow` / `TextureSender` に束縛した
`createTextureBridgeWith` にすぎません。ファクトリは Electron の `app` / `screen`
グローバルを引き続き直接参照し、プレビューウィンドウも自前で構築します
（`PreviewManager`）— このシームはウィンドウ / センダーの構築のみを注入可能にし、
ファクトリ全体を Electron 非依存にするものではありません。完全に Electron 無しの
テスト環境が必要な場合は、`app` / `screen` を別途モックしてください。

### `TextureBridge`

返されるハンドル：

```typescript
interface TextureBridge {
  on(event: "fps", listener: (fps: number) => void): this;
  on(event: "ready", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "frameDropped", listener: (defect: PaintDefect) => void): this;
  on(event: "resize", listener: (width: number, height: number) => void): this;
  on(event: "disposed", listener: () => void): this;

  resize(width: number, height: number): void;  // 全レイヤー + Worker にカスケード
  openPreview(): void;
  closePreview(): void;
  forwardFrames(target: WebContents, options?: FrameForwardOptions): FrameForward;
  dispose(): void;

  readonly renderWindow: BrowserWindow;
  readonly previewWindow: BrowserWindow | null;
  readonly isDisposed: boolean;
  readonly droppedReason: PaintDefect["reason"] | null;
}
```

`frameDropped` は、paint フレームがセンダーに届く前にドロップされたときに発火します
（`reason`: `"no-texture" | "no-nt-handle" | "no-io-surface" | "unsupported-platform"`）。
エラーではありませんが、継続的に発火する場合はレシーバー側で黒画面になります。
同じ理由が連続する場合はデデュープされます：イベントは最初の発生時に一度発火し、
成功した送信または理由の変化があった後に再び発火します。リスナーをアタッチする前に
ドロップが確定していた場合（例: レンダラーページがまだロード中の場合）は、
`bridge.droppedReason` を読んでください — 最新のドロップ理由、または成功した送信の後は
`null` を保持します。

`dispose()` は、オフスクリーンの `renderWindow` を `close()` ではなく
`destroy()` で同期的に破棄します。これにより、Electron の `before-quit` との
競合でクラッシュダイアログが出るリスクがなくなります。ここから 2 点が
帰結します:

- **`disposed` リスナーで `bridge.renderWindow.webContents` に触れてはいけません** —
  `disposed` が発火する時点で、オフスクリーンウィンドウはすでに破棄済みです。
- **レンダーウィンドウの `close` イベントと、ページの `beforeunload`/`unload`
  ハンドラはもう発火しません** — これは `destroy()` の仕様どおりの挙動です。
  `closed` イベントは引き続き発火します。

プレビューウィンドウは影響を受けません: 実在する可視ウィンドウであり、
引き続き `close()` により通常のクローズセマンティクスで閉じます。以前、
旧来の非同期な `close()` を避けるため `bridge.dispose()` の後に自前で
`bridge.renderWindow.destroy()` を呼ぶワークアラウンドをしていた場合は、
**その外部からの `destroy()` 呼び出しを削除してください** — `dispose()` が
今はそれを内部で行うため、`dispose()` の後に呼ぶとすでに破棄済みのウィンドウ
に対して呼び出すことになり、Electron は二重の `destroy()` が安全であることを
保証していません（"Object has been destroyed" で例外になり得ます）。ライブラリ
側のガードは `dispose()` 内部の呼び出しのみを保護するものであり、`dispose()`
呼び出し後に外部から呼ばれる `destroy()` までは保護しません。すぐに削除できない
場合は、自分でガードする
（`if (!bridge.renderWindow.isDestroyed()) bridge.renderWindow.destroy();`）か、
`dispose()` より前に呼び出すようにしてください。

### `TextureBridge.forwardFrames(target, options?)`

```typescript
const forward = bridge.forwardFrames(monitorWindow.webContents, { extraArgs: [slot] });
// 後で
forward.dispose(); // 冪等
```

`WebContents`（モニター/マルチビューアウィンドウなど）を登録し、以降すべての paint フレームを `forwardSharedTexture` と同じゼロコピーの shared-texture 経路で受け取れるようにします — ピクセル readback はなく、GPU ハンドルの受け渡しのみです。

**ベストエフォート契約** はプレビュー経路と同一です: 転送失敗（core の `forwardSharedTexture` primitive が返す `ForwardDefect`）はこの driver が握り潰し、`"error"` イベントや `frameDropped` / `droppedReason` を汚しません。**ネイティブの Syphon/Spout 送信からは独立** しています — paint ハンドラ内で転送は `sendTextureFromPaintEvent` より先に実行されるため、ネイティブ送信が throw しても登録済みの転送を止められませんし、転送側の失敗がネイティブ送信をブロックすることもありません。両者は互いの結果と無関係に発火します。

`FrameForward.dispose()` はその 1 件の登録だけを解除し、冪等です — 2 回呼んでも、あるいは `bridge.dispose()` が先に全登録を解除した後に呼んでも no-op です。`bridge.dispose()` は登録済みの転送をすべて解除します。

受け取り側は新たに何も必要ありません: 転送先の target は Syphon/Spout レシーバーとまったく同じ方法でフレームを受け取ります — renderer 起動時に一度 `bindSharedTextureReceiver(sharedTexture)` を呼び、`receiver.consume({ onFrame: (frame, ...extraArgs) => ... })` で受信します。`forwardFrames(target, { extraArgs })` に渡した `extraArgs` はハンドラの末尾引数としてそのまま届くため、1 つの target が複数ソースからの転送を（例えばスロット番号で）判別できます。

現在の実装は、フレームごとに登録済み target の数だけテクスチャを import します。複数 target が同一ソースフレームを共有する場合は「フレームごとに import は 1 回 → 全 target へ send → 全 send の settle 後に release」へ最適化する余地がありますが、現時点でその需要のある呼び出し元がないため（multiviewer は 1 ソース = 1 target）、将来のオプションとして記録するに留め、実装はしていません。

### `createWorkerRenderer(options)`（`renderer/client` から）

キャンバスから Worker へのパイプラインを設定するレンダラープロセス用ヘルパー。ResizeObserver による自動リサイズ伝播付き。

```typescript
import { createWorkerRenderer } from "@napolab/texture-bridge-renderer/client";

createWorkerRenderer({
  worker: new MyWorker(),
  width: 1920,
  height: 1080,
});
```

### `bindSharedTextureReceiver(sharedTexture)`（`renderer/client` から）

```typescript
import { sharedTexture } from "electron";
import { bindSharedTextureReceiver } from "@napolab/texture-bridge-renderer/client";

// Electron の単一の sharedTexture.setSharedTextureReceiver スロットを束縛します。
// 副作用はこれだけです。レンダラー起動時に一度だけ呼び出してください。
const receiver = bindSharedTextureReceiver(sharedTexture);

const registration = receiver.consume({
  onFrame: ({ textureId, videoFrame }, ...extraArgs) => {
    // videoFrame は共有テクスチャに裏付けられた Web VideoFrame です。
    // drawImage(videoFrame) — ゼロコピー GPU blit
    // device.importExternalTexture({ source: videoFrame }) — WebGPU 経路
  },
  onError: (err) => console.error(err),
});

registration.dispose();   // このコンシューマーをプールから削除（冪等）
receiver.dispose();       // バインディングを破棄（冪等）
```

Electron の単一の `sharedTexture.setSharedTextureReceiver` スロットを新しいコンシューマープールに束縛し、`BoundSharedTextureReceiver` ハンドルを返します。Electron の `sharedTexture` モジュールは内部で import せず引数で受け取るため、バインディングの持ち主と寿命がコード上で明確になります（テストでは `{ setSharedTextureReceiver: vi.fn() }` を渡せます）。Electron 40+ が必要です。

ハンドルのメソッドは 2 つです。

- **`consume(handlers)`** — このバインディングのプールにコンシューマーを 1 つ登録し、`{ dispose() }`（冪等）を返します。登録するだけで、Electron のスロットには触れません。複数のコンシューマーが共存でき、アクティブな各コンシューマーは届いた import 済みテクスチャごとに専用の `VideoFrame` を受け取ります。ラッパーは `onFrame` が完了した後にその `VideoFrame` を close し、全コンシューマーの処理が終わった後に一度だけ、元の import 済みテクスチャを release します。main プロセス側で渡した `extraArgs`（`forwardFrames(target, { extraArgs })`、`createSharedTextureReceiver({ extraArgs })`）は、ハンドラの末尾引数としてそのまま届きます。
- **`dispose()`** — 冪等です。登録済みのコンシューマーをすべて破棄し、`sharedTexture` を再びバインドできる状態に戻します。Electron にはレシーバーを解除する API がないため、設置済みのコールバックは残り、その後に届いたフレームも引き続き受け取って release します。同じ target に対して再度 `bindSharedTextureReceiver` を呼ぶと、そのコールバックが置き換わります（Electron のスロットは後勝ちです）。

エラー（どちらも `renderer/client` からエクスポートされています）:

| エラー | 発生条件 |
| ------ | -------- |
| `SharedTextureReceiverAlreadyBoundError` | すでに有効なバインディングを持つ `sharedTexture` に対して `bindSharedTextureReceiver` を呼んだとき。先に既存のバインディングを `dispose()` してください。 |
| `SharedTextureReceiverDisposedError` | `dispose()` 済みのハンドルで `consume()` を呼んだとき。 |

ハンドラの型 `SharedTextureConsumerFrame`、`SharedTextureConsumerHandlers`、`SharedTextureConsumerRegistration` と、`BoundSharedTextureReceiver`、`SharedTextureReceiverTarget` は `renderer/client` から型としてエクスポートされています。

> 以前のグローバルな「install してから consume する」関数ペアはこの API に置き換えられ、削除されました。移行するには、一度だけ `const receiver = bindSharedTextureReceiver(sharedTexture);` でバインドし、これまでコンシューマーを登録していた箇所で `receiver.consume(h)` を呼んでください。

### `createMultiDispatcher(options)`（`renderer/client` から）

低レベルなファンアウト primitive です: 1 回の `handler(...)` 呼び出しが登録済みの全コールバックを呼び出し、その結果をユーザー指定の `combine` 関数で reduce します。`bindSharedTextureReceiver` はこの上に構築されていますが、「1 つの上流スロットに対して複数の下流コンシューマー」というアダプター（例: preload→renderer ブリッジ）を自作できるようにエクスポートされています。完全な API は `packages/renderer/src/client/multi-dispatcher.ts` の JSDoc を参照してください。

### `createSharedTextureReceiver(options): SharedTextureReceiverBridge`

**ゼロコピー GPU** レシーバーブリッジを作成するファクトリ関数です。`TextureReceiver.receiveSharedTexture()` をポーリングし、各フレームを Electron の `sharedTexture.importSharedTexture` + `sendSharedTexture` のペア経由で対象の renderer に配送します。Windows（Spout）と macOS（Syphon Metal）の両方でエンドツーエンド検証済みです。

```typescript
interface SharedTextureReceiverOptions {
  senderName: string;                 // Syphon サーバー / Spout センダー名
  target?: Electron.WebContents;      // primary のレシーバー webContents（省略可: すべて forwardFrames で登録してもよい）
  mode?: "push" | "poll";             // macOS/Windows は "push"、それ以外は "poll" がデフォルト。push は latest-wins
  pollIntervalMs?: number;            // poll モードのみ。デフォルト 16（約 60fps）；drop-latest を適用
  appName?: string;                   // （macOS のみ）アプリケーション名でフィルタ
  serverUuid?: string;                // （macOS のみ）サーバー UUID で接続
  extraArgs?: readonly unknown[];     // primary target のみ。sendSharedTexture(..., ...args) へ転送される
}

interface SharedTextureReceiverBridge {
  on(event: "fps", listener: (fps: number) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "disposed", listener: () => void): this;

  start(): void;                      // ポーリングを開始
  stop(): void;                       // ポーリングを一時停止（再度 start 可能）
  dispose(): void;                    // 終端: stop + ネイティブレシーバーの release
  [Symbol.dispose](): void;           // dispose() と同じ

  // fan-out: 1 フレームにつきネイティブ受信 1 回・import 1 回で全 target へ送る
  forwardFrames(target: Electron.WebContents, options?: FrameForwardOptions): FrameForward;

  readonly isDisposed: boolean;
}
```

`dispose()` は終端かつ冪等です。`"error"` イベントが 10 回連続すると、ブリッジは自動的に停止し（サーキットブレーカー）、シャットダウン理由を説明する最終エラーを 1 回発火します。

#### `SharedTextureReceiverBridge.forwardFrames(target, options?)`

ネイティブ受信を増やさずに、同じソースを別の target にも配信します。各フレームは 1 回だけ import され、生きている全 target（省略可能な primary の `target` と、すべての forward）に送られます。import 済みテクスチャは、そのフレームの送信がすべて完了（成功・失敗とも）した後に 1 回だけ release されます。

```typescript
// ソース 1 つにレシーバー 1 つ、ビューアーは複数
const receiver = createSharedTextureReceiver({ senderName: "Resolume Arena" });
const main = receiver.forwardFrames(mainWindow.webContents, { extraArgs: [0] });
const monitor = receiver.forwardFrames(multiviewer.webContents, {
  extraArgs: [3],
  onStatus: (status) => console.log("[monitor]", status),
});
receiver.start();

monitor.dispose(); // その target への配信を止める（冪等）
```

契約は [`TextureBridge.forwardFrames`](#texturebridgeforwardframestarget-options) と同じです。受信側に固有の点は次のとおりです。

- **target ごとの latest-wins。** 各 target は送信中 1 つと待機中 1 つまでしかフレームを持ちません。遅い renderer は自分の分だけフレームを落とし、ほかの target は全フレームを受け取り続けます。
- **best-effort。** forward の import / 送信の失敗は `onStatus`（状態が変わったときだけ）でのみ通知されます。`"error"` には出ず、サーキットブレーカーにも数えません。受信エラー、import エラー、primary の `target` への送信エラーは従来どおり `"error"` とサーキットブレーカーで扱います。
- **target がなければ import しない。** 生きている target が 1 つもないとき（target なしのレシーバーで forward をすべて dispose した場合など）は、import せずにネイティブハンドルを close します。
- **ライフサイクル。** forward は target が破棄されると自動で登録解除されます。`stop()` / `dispose()` は待機中のフレームをすべて手放し、戻った後に送信は起きません。`dispose()` 後や破棄済みの target で `forwardFrames()` を呼ぶと、何もしない handle（`active: false`）が返ります。
- `"fps"` は少なくとも 1 つの target に届いたフレームを数えます。届いたフレームはサーキットブレーカーのカウンタもリセットします。

### `createTextureReceiver(options): TextureReceiverBridge`

ポーリングと FPS 計測を備えたテクスチャレシーバーを作成するファクトリ関数です。

```typescript
interface TextureReceiverBridgeOptions {
  senderName: string;      // Syphon サーバー名 / Spout センダー名
  appName?: string;        // （macOS のみ）アプリケーション名でフィルタ
  serverUuid?: string;     // （macOS のみ）サーバー UUID で接続
  pollIntervalMs?: number; // フレームポーリング間隔（ms、デフォルト: 16）
}
```

### `TextureReceiverBridge`

```typescript
interface TextureReceiverBridge {
  on(event: "frame", listener: (frame: ReceivedFrame) => void): this;
  on(event: "fps", listener: (fps: number) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "disposed", listener: () => void): this;

  start(): void;   // フレームのポーリングを開始
  stop(): void;    // ポーリングを一時停止
  dispose(): void; // 全リソースを解放

  readonly isDisposed: boolean;
}

interface ReceivedFrame {
  data: Buffer;    // RGBA ピクセルデータ
  width: number;
  height: number;
}
```

### `SenderDiscovery`

利用可能な Syphon サーバー / Spout センダーをポーリングし、差分イベントを発行する EventEmitter です。

```typescript
const discovery = new SenderDiscovery();
discovery.on("added", (senders: SenderInfo[]) => { /* 新しいセンダーが出現 */ });
discovery.on("removed", (senders: SenderInfo[]) => { /* センダーが消失 */ });
discovery.on("updated", (senders: SenderInfo[]) => { /* 現在の全リスト */ });
discovery.start(1000); // ポーリング間隔（ms）
discovery.getSenders(); // 現在のセンダーリスト
discovery.dispose();

interface SenderInfo {
  name: string;
  appName?: string;  // macOS のみ
  uuid?: string;     // macOS のみ
}
```

### Worker プロトコル型（`renderer/worker` から）

```typescript
import type { WorkerMessage } from "@napolab/texture-bridge-renderer/worker";

// Worker 内:
self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  switch (e.data.type) {
    case "init":   /* e.data.canvas: OffscreenCanvas */ break;
    case "resize": /* e.data.width, e.data.height */   break;
    case "dispose": break;
  }
};
```

## `@napolab/texture-bridge-core`

### `sendTextureFromPaintEvent(sender, textureInfo)`

プラットフォーム固有のテクスチャハンドルの取得と転送を自動的に処理する低レベル関数です。

- **macOS**: `handle.ioSurface` バッファを読み取り → `sender.sendSurface()` を呼び出し
- **Windows**: `handle.ntHandle` バッファを BigInt64LE として読み取り → `sender.send()` を呼び出し

フレームがセンダーに渡された場合は `undefined` を返し、フレームがドロップされた場合は
`PaintDefect`（`{ reason: "no-texture" | "no-nt-handle" | "no-io-surface" | "unsupported-platform" }`；
`unsupported-platform` バリアントには該当する `platform` も含まれます）を返します。
ドロップは通常のノーオペレーションであり、エラーではありません — `createTextureBridge` が
`frameDropped` イベントで行っているのと同様に、自前の paint ループでも表面化させてください。
ネイティブの送信失敗は `TextureSendError`（両パッケージからエクスポートされます）として
throw されます — メッセージはそのまま保持され、元の throw 値は `error.cause` から参照できます。
`createTextureBridge` を使っている場合、これらはブリッジの `error` イベントとして表面化するため、
`instanceof TextureSendError` で判別できます。

### `forwardSharedTexture(textureInfo, target, extraArgs?)`（`core/electron` から）

```typescript
import { forwardSharedTexture, type ForwardDefect } from "@napolab/texture-bridge-core/electron";

const defect = await forwardSharedTexture(textureInfo, target, extraArgs);
```

1 フレームの paint を、Electron の shared-texture チャネル（`sharedTexture.importSharedTexture` → `sharedTexture.sendSharedTexture`）経由で renderer の `WebContents` に転送します。ゼロコピー — プロセス境界を越えるのは GPU ハンドルのみで、ピクセルは動きません。

この関数はパッケージのメインエントリではなく、**独立したサブパス** `@napolab/texture-bridge-core/electron` に置かれています。メインエントリは Electron 未インストールでも import できる状態を保つ必要があります（前述の「Electron 無しの最小サニティチェック」の `sendRgbaBuffer` がそれに依存しています）。そのためこの関数が必要とする静的な `import { sharedTexture } from "electron"` はこのサブパスに隔離し、メインエントリの出力に electron-free ガードをビルド時に適用して強制しています。

フレームが Electron への配送に成功した場合は `undefined` を、失敗した理由は `ForwardDefect` で返します — `sendTextureFromPaintEvent` の `PaintDefect | undefined` と同じ報告方式です: 低レベル層は結果を報告するだけで、判断は呼び出し側に委ねます。

```typescript
type ForwardDefect =
  | { reason: "target-destroyed" }   // target.isDestroyed()、または mainFrame が存在しない
  | { reason: "import-failed"; cause: Error }
  | { reason: "send-failed"; cause: Error };
```

`async` 関数であるため、同期的に throw することは構造的にありません — 失敗は常に返り値の Promise を通じて表面化し、呼び出し箇所で例外として飛ぶことはありません。import に成功した場合は、後続の send が成功しても失敗しても `finally` で必ず import 済みテクスチャを release します（release-in-finally）。

自前の paint ループを持つ低レベル利用者は、`sendTextureFromPaintEvent` と並べて直接呼び出せます。texture の release は `finally` で行ってください — `sendTextureFromPaintEvent` はネイティブ送信の失敗時に throw するため、`finally` を使わないと `texture.release()` がスキップされてフレームがリークします。`forwardSharedTexture` は同期的に throw しない（前述）ため、`await` せず fire-and-forget しても安全です — ディスパッチ自体は同期的に開始されるため:

```typescript
win.webContents.on("paint", (e) => {
  const texture = e.texture;
  if (!texture) return;
  try {
    void forwardSharedTexture(texture.textureInfo, monitorWC, [slot]); // → renderer（ディスパッチは同期）
    sendTextureFromPaintEvent(sender, texture.textureInfo);           // → Syphon/Spout（失敗時は throw）
  } finally {
    texture.release();
  }
});
```

### `sendImportedTexture(frame, imported, extraArgs?)`（`core/electron` から）

```typescript
import { sendImportedTexture } from "@napolab/texture-bridge-core/electron";

await sendImportedTexture(targetFrame, importedSharedTexture, extraArgs);
```

**すでに import 済みの** shared texture（`sharedTexture.importSharedTexture(...)` の戻り値）を対象の `WebFrameMain` に配送し、send の成否に関わらず `finally` で必ず release します — release-in-finally は `forwardSharedTexture` 内部の配送ステップと同じ契約です。これは `forwardSharedTexture`（前述）とレンダラーパッケージの shared-texture receiver 経路（`shared-texture-receiver.ts`、`preview-manager.ts`）の両方が内部で呼び出している共有ヘルパーで、「配送して必ず release する」処理の実装が重複せず一本化されています。ほとんどの利用者は `importSharedTexture` のステップも行う `forwardSharedTexture` を使うべきです — `sendImportedTexture` を直接使うのは、すでに他所（例: receiver のポーリングループ）で import 済みのテクスチャを持っていて、send-and-release の半分だけが必要な場合に限ります。

### `TextureSender`

Syphon/Spout レシーバーにテクスチャを送信するネイティブクラスです。

```typescript
class TextureSender {
  constructor(name: string, width: number, height: number);
  send(handle: number, width: number, height: number): void;
  sendSurface(surfaceBuffer: Buffer, width: number, height: number): void;
  sendRgbaBuffer(data: Buffer, width: number, height: number, bytesPerRow?: number): void;
  platform(): string;
  stop(): void;  // 終端 — ネイティブリソースを即座に解放
}
```

### `TextureReceiver`

Syphon/Spout センダーからテクスチャを受信するネイティブクラスです。

```typescript
class TextureReceiver {
  constructor(senderName: string, appName?: string, serverUuid?: string);
  hasNewFrame(): boolean;
  receiveFrame(): ReceivedFrame | null;                  // RGBA readback
  receiveSharedTexture(): SharedTextureFrame | null;     // ゼロコピー GPU ハンドル（Windows + macOS）
  isConnected(): boolean;
  getWidth(): number;
  getHeight(): number;
  platform(): string;
  stop(): void;  // 終端 — ネイティブリソースを即座に解放
}

interface SharedTextureFrame {
  width: number;
  height: number;
  pixelFormat: "bgra" | "rgba" | "rgbaf16";
  ownerPid: number;        // ハンドルを所有するプロセス ID（通常は process.pid）
  handle: Buffer;          // 8 バイト LE: Windows では NT HANDLE、macOS では IOSurfaceRef ポインタ
}
```

各 `handle` は新規に発行された、所有権を持つネイティブ参照です。すべての `handle` について `closeNativeHandle(handle)` をちょうど 1 回呼んでください。`sharedTexture.importSharedTexture` に渡した後も同じです — `importSharedTexture` は所有権を引き取らず、自前で複製 / retain した参照を持ちます。呼ばないとフレームごとに NT HANDLE / IOSurface の retain がリークします。

### `closeNativeHandle(handle)`

```typescript
function closeNativeHandle(handle: Buffer): void;
```

`receiveSharedTexture()` が発行したネイティブの共有テクスチャハンドル（Windows では NT HANDLE、macOS では `IOSurfaceRef`）について、呼び出し側の参照を解放します。import したかどうかに関わらず、ハンドルごとにちょうど 1 回呼んでください。Electron の `importSharedTexture` は自前で複製 / retain した参照を持つため、import の呼び出しが返った直後（成功でも例外でも）に呼んで問題ありません。同じハンドルに 2 回呼ぶと二重 close / 過剰 release になります。

### リソースのライフサイクル

`TextureSender` と `TextureReceiver` はどちらも決定的な破棄セマンティクスに従います:

1. **`stop()` はネイティブリソースを即座に解放します。** クリーンアップをガベージコレクションに頼らないでください。
2. **`stop()` は終端です。** 呼び出し後、インスタンスは再利用できません。`stop()` 以降に操作系メソッドを呼ぶと、エラーを throw する（sender）か、安全な終端値を返します（receiver）。
3. **`stop()` は冪等です。** 繰り返し呼び出しても安全で、エラーなく返ります。
4. **上位の `dispose()` メソッド**（`TextureBridge`、`TextureReceiverBridge` 上）はネイティブの `stop()` に転送され、これも終端です。

```typescript
// 推奨パターン
const sender = new TextureSender("MyApp", 1920, 1080);
try {
  // ...センダーを使用...
} finally {
  sender.stop();
}

// `using` 宣言で使うための Symbol.dispose にも対応しています。
// Node.js 22+（または Symbol.dispose 対応ランタイム）と、
// tsconfig.json の `"lib": ["ESNext.Disposable"]` が必要です。
// ランタイムの Symbol.dispose パッチには @napolab/texture-bridge-core からインポートしてください。
using sender = new TextureSender("MyApp", 1920, 1080);
```

### `listSenders()`

```typescript
function listSenders(): Array<{ name: string; appName?: string; uuid?: string }>;
```

### `getPlatform()`

```typescript
function getPlatform(): "spout" | "syphon-metal" | "unsupported";
```

`getPlatform()` とインスタンスメソッド `sender.platform()` / `receiver.platform()` は同じ文字列集合を返します：

| 値 | 意味 |
|----|------|
| `"syphon-metal"` | macOS — Syphon Metal バックエンド有効 |
| `"spout"` | Windows — Spout バックエンド有効 |
| `"unsupported"` | バックエンドのないプラットフォーム（送受信は no-op） |

### 型定義

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
