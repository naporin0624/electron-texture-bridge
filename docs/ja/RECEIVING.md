# Spout/Syphon からのテクスチャ受信

受信経路は 2 つあり、それぞれ解決する問題が異なります。

- **`TextureReceiver.receiveFrame()` / `createTextureReceiver()`** — RGBA リードバック。ネイティブ側が GPU→CPU ブリット（D3D11 ステージング / Metal ブリット）を実行し、IPC を 1 回経由して `ArrayBuffer` を渡します。1080p 1 フレームあたり約 8 MB が IPC 経由でコピーされます。JavaScript 側で実際にピクセルデータが欲しい場合（解析、画像エクスポート、独自のカラーパイプラインなど）に使ってください。
- **`TextureReceiver.receiveSharedTexture()` / `createSharedTextureReceiver()` / `bindSharedTextureReceiver()`** — ゼロコピー GPU 配信。ネイティブ側がフレームごとにプラットフォームネイティブな共有ハンドル（Windows では DXGI NT ハンドル、macOS では IOSurface ポインタ）を発行し、Electron の `sharedTexture.importSharedTexture` + `sendSharedTexture` のペアを介してレンダラーへ `VideoFrame` として渡します。CPU リードバックも `ArrayBuffer` の IPC コピーもありません。`ctx.drawImage(videoFrame, 0, 0)` は GPU 上で完結し、`GPUDevice.importExternalTexture({ source: videoFrame })` も同じテクスチャをコピーなしで WebGPU に渡します。受信した映像を表示するだけ、あるいは GPU 上で処理したいだけの場合に使ってください。

そのフレームで何をしたいかに応じて、どちらか一方を選んでください。

> **ステータス。** ゼロコピー GPU 経路は Windows（Spout）と macOS（Syphon Metal）の両方でエンドツーエンドの動作を確認済みです。macOS ではレシーバーがフレームごとに新しい `IOSurfaceRef` を発行し、レシーバーごとのステージング用 `MTLTexture` を経由して小さなレンダーパスで Y 反転を行うため、`drawImage(videoFrame)` / `importExternalTexture({ source: videoFrame })` の結果が正しい向きで表示されます。同じ `closeNativeHandle()` の所有権契約（後述）が両プラットフォームに適用されます。

## メインプロセス: `createSharedTextureReceiver`

```typescript
// main process
import { app, BrowserWindow } from "electron";
import { createSharedTextureReceiver } from "@napolab/texture-bridge-renderer";

app.whenReady().then(() => {
  const receiverWindow = new BrowserWindow({
    width: 960,
    height: 540,
    webPreferences: {
      preload: /* path to preload that installs the consumer */ undefined,
    },
  });

  const bridge = createSharedTextureReceiver({
    senderName: "Resolume Arena",   // required
    target: receiverWindow.webContents,
    mode: "push",                   // optional, "push" (default on macOS/Windows) | "poll"
    pollIntervalMs: 8,              // optional, poll mode only, defaults to 16
    appName: undefined,             // optional, macOS filter
    serverUuid: undefined,          // optional, macOS UUID
    extraArgs: [],                  // optional, forwarded to sendSharedTexture(..., ...args)
  });

  bridge.on("fps", (fps) => console.log(`[receiver] ${fps.toFixed(1)} fps`));
  bridge.on("error", (err) => console.error("[receiver]", err.message));
  bridge.on("disposed", () => console.log("[receiver] disposed"));

  bridge.start();

  receiverWindow.on("closed", () => {
    bridge.dispose();   // stops polling, releases the native receiver, emits "disposed"
  });
});
```

このブリッジは drop-latest ポリシーで動作します。前回の `sendSharedTexture` がまだ処理中の状態で次のポーリングが発火した場合、そのティックはスキップされます。これにより main プロセス側で保持される import 済みテクスチャ参照は常に最大 1 個に抑えられ、レンダラーの処理が遅い場合でもフレームが積み上がるのを防ぎます。

### push モードとステージングリング

`mode: "push"`（macOS / Windows の既定値）では、ネイティブ側がセンダーの新しいフレームをレシーバーが所有する 3 つの GPU スロットのいずれかにステージングし、そのスロットのハンドルでコールバックします。送信中に届いたフレームは最新の 1 つだけを保持します（latest-wins）。ブリッジは `importSharedTexture` が返った直後に毎回ハンドルを close します（Electron は自前の参照を持つため）。そのため、スロットが「下流でまだ使われているか」の判定に呼び出し側のハンドルは使えません。

- **macOS:** `IOSurfaceRef` がリング自身の参照より多く retain されているか、`IOSurfaceIsInUse` が使用中を返す間、そのスロットは使いません。Electron の import は `CFGetRetainCount` に現れないため、実際にレンダラーがまだ参照しているスロットを守っているのは `IOSurfaceIsInUse` です。3 スロットすべてが使用中ならフレームはネイティブ側で破棄されます（"all 3 ring slots still held downstream" とログに出ます）。
- **Windows:** スロットが使用中とみなされるのは、そのスロット用に渡した NT ハンドルがまだ開いている間だけです（`CompareObjectHandles`）。ブリッジは import 直後にハンドルを close するので、この判定は実質的に常に「空き」となり、リングは 3 スロットの単純なラウンドロビンになります。レンダラーがまだ参照しているスロットは検出できません。それでも、poll 経路が毎フレーム使い回す単一のステージングテクスチャよりは確実に良くなります。`CompareObjectHandles` のない Windows 10 1607 より前の環境では、一度渡したスロットがずっと使用中扱いになり、3 フレームで push 配信が止まります。その環境では `mode: "poll"` を使ってください。

## レンダラープロセス: `bindSharedTextureReceiver` + `receiver.consume`

```typescript
// renderer process (or preload with nodeIntegration: true, contextIsolation: false)
import { sharedTexture } from "electron";
import { bindSharedTextureReceiver } from "@napolab/texture-bridge-renderer/client";

// Call once at startup. Binds Electron's single
// sharedTexture.setSharedTextureReceiver slot to a pool so multiple consumers
// can coexist. Binding the same sharedTexture twice (without dispose) throws
// SharedTextureReceiverAlreadyBoundError.
const receiver = bindSharedTextureReceiver(sharedTexture);

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

const registration = receiver.consume({
  onFrame: ({ textureId, videoFrame }) => {
    if (canvas.width !== videoFrame.displayWidth) canvas.width = videoFrame.displayWidth;
    if (canvas.height !== videoFrame.displayHeight) canvas.height = videoFrame.displayHeight;
    // Zero-copy GPU blit in Chromium when the source is a shared-texture VideoFrame.
    ctx.drawImage(videoFrame, 0, 0);
  },
  onError: (err) => console.error("[consumer]", err),
});

// registration.dispose();  // optional — removes this consumer from the pool
// receiver.dispose();      // optional — tears the binding down (idempotent)
```

`videoFrame` は標準の Web `VideoFrame` です。WebGPU で使う場合は `drawImage` の代わりに `device.importExternalTexture({ source: videoFrame })` に渡してください — こちらの経路もゼロコピーです。`videoFrame.close()` を自分で呼ぶ**必要はありません**。ハンドラーが返す Promise が解決した後、consumer 側のラッパーが close します。

`receiver.dispose()` はすべてのコンシューマーを破棄し、同じ `sharedTexture` を再びバインドできる状態に戻します。その後に `receiver.consume()` を呼ぶと `SharedTextureReceiverDisposedError` が投げられます。Electron にはレシーバースロットを解除する手段がないため、設置済みのコールバックはその後に届いたフレームも引き続き受け取って release します。詳しくは [API リファレンス](API.md#bindsharedtexturereceiversharedtexturerendererclient-から) を参照してください。

## オプション: `TextureReceiver.receiveSharedTexture()` を直接ポーリングする

自前のスケジューラと統合するなど、ポーリングループ自体を自分で駆動したい場合は、低レベルのプリミティブを使い、ハンドルを手動で `sharedTexture.importSharedTexture` に渡してください。

```typescript
import { TextureReceiver, closeNativeHandle } from "@napolab/texture-bridge";
import { sharedTexture } from "electron";

const receiver = new TextureReceiver("Resolume Arena");
const frame = receiver.receiveSharedTexture();
if (frame) {
  const handle =
    process.platform === "win32" ? { ntHandle: frame.handle } : { ioSurface: frame.handle };
  try {
    const imported = sharedTexture.importSharedTexture({
      textureInfo: {
        codedSize: { width: frame.width, height: frame.height },
        handle,
        pixelFormat: frame.pixelFormat,   // "bgra" | "rgba" | "rgbaf16"
      },
    });
    // ... deliver `imported` via sendSharedTexture, then imported.release() ...
  } finally {
    // importSharedTexture はハンドルを引き取らない（自前で複製 / retain した
    // 参照を持つ）ため、import の成否に関わらず自分の参照を解放する。
    closeNativeHandle(frame.handle);
  }
}
```

> **所有権契約。** `receiveSharedTexture()` が返す `SharedTextureFrame.handle` は、そのつど新しく発行され、呼び出し側が所有するネイティブハンドルです。`importSharedTexture` が成功した場合も含め、**すべての**経路で `closeNativeHandle(frame.handle)` をちょうど 1 回呼んでください。Electron はハンドルの所有権を引き取りません。`importSharedTexture` は NT ハンドルを `DuplicateHandle`（Windows）し、`IOSurfaceRef` を retain（macOS）して自前の参照を持ち、import 済みテクスチャが release されたときにその参照を手放します。そのため、import の呼び出しが返った直後（成功でも例外でも）に close して問題ありません。上の例の `finally` がこれにあたります。import しない経路（未知のピクセルフォーマット、ターゲットが破棄済み、フレームをスキップすると決めた、など）でも close します。close を忘れると、フレームごとに NT HANDLE（Windows）/ `IOSurfaceRef` の retain（macOS）が 1 つずつリークします。`createSharedTextureReceiver` はこれをすべて自動で行います。

## 利用可能なセンダーの検出

```typescript
import { listSenders } from "@napolab/texture-bridge-renderer";

for (const s of listSenders()) {
  console.log(s.name, s.appName ?? "", s.uuid ?? "");
}
// [{ name: "Resolume Arena", appName: "Resolume Arena", uuid: "..." }, ...]
```

継続的な変更通知が必要な場合は `SenderDiscovery` を使ってください（[API リファレンス](API.md#senderdiscovery)を参照）。

## レンダラーのコンテキスト分離

Electron の `sharedTexture` モジュールは、`electron` を実行時に解決できる main / renderer プロセスからのみアクセスできます。`@napolab/texture-bridge-renderer/client` を Vite 駆動のレンダラーから直接 import すると、dev のプリバンドル時に失敗することがあります（`path.join is not a function`）。これは Vite が `electron` の CJS モジュールをプリバンドルできないためです。回避方法は 2 つあります。

1. **単純なケースでの推奨方法:** `bindSharedTextureReceiver(sharedTexture)` と `receiver.consume()` を **preload スクリプト**（electron-vite / electron-builder が `externalizeDepsPlugin` でバンドルする）に置き、レシーバーウィンドウを `nodeIntegration: true, contextIsolation: false` で実行します。サンプルアプリはこの方式を採っています — [`packages/example/src/preload/receiver.ts`](../../packages/example/src/preload/receiver.ts) を参照してください。
2. **コンテキスト分離を維持する場合:** consumer を preload 側でバインドし、各 `VideoFrame` を `window.postMessage(videoFrame, "*", [videoFrame])`（`VideoFrame` は transferable です）で分離された renderer world へ転送します。使用後は renderer 側で close してください。
