# トラブルシューティング

## paint イベントが発火しない

- `win.webContents.setFrameRate(60)` を設定しているか確認
- `show: false` でも paint イベントは発火する
- レンダラー/ワーカー内で `requestAnimationFrame` ループが動いているか確認

## テクスチャが真っ黒

- **DPR / Retina のサイズ不一致（最も多い）。** **Electron ≤ 40:** Retina ディスプレイや Windows のディスプレイスケーリング下では実フレームバッファが `width × height × scaleFactor` になり、論理サイズで宣言したセンダーと食い違ってレシーバーが黒/崩れになります。`createTextureBridge({ pixelExact: true })` を使うか、低レベル core 経路ではセンダーを実フレームバッファサイズで宣言するか自分で DPR を打ち消してください。**Electron ≥ 41:** `createTextureBridge` が OSR のデバイススケールファクターを `1` に固定するため、この不一致は発生しません — [移行ガイド: Electron 42 / OSR デバイススケール](MIGRATION.md#移行ガイド-electron-42--osr-デバイススケール)を参照してください。低レベル core 経路では自分で `offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }` を渡してください。（[Retina/DPI の警告](SENDING.md)参照）。
- **Electron とブリッジの切り分け**には[Electron 無しのサニティチェック](SENDING.md)を使ってください — `sendRgbaBuffer` が VJ アプリに映ればネイティブ側は健全で、問題は Electron OSR 経路にあります。
- `preserveDrawingBuffer` は不要（Chromium のコンポジターが直接読み取る）
- ピクセルフォーマットの不一致を確認：Chromium は BGRA を出力するので、レシーバー側も BGRA を期待しているか確認
- `bridge.on("frameDropped", ...)` を購読する（または `sendTextureFromPaintEvent` の
  戻り値を確認する）— `no-nt-handle` / `no-io-surface` の理由が継続する場合、
  Chromium が共有可能な GPU ハンドルを配信していないことを意味し、
  それ以外では黒画面としてのみ現れます。

## Syphon レシーバーに表示されない（macOS）

- `vendor/Syphon.framework` が正しい場所にあるか確認
- Gatekeeper の隔離属性をクリア：`xattr -dr com.apple.quarantine vendor/Syphon.framework`
- Console.app でエラーログを確認

## Spout レシーバーに表示されない（Windows）

- Spout2 がシステムにインストールされているか確認
- GPU ドライバが最新か確認
- DirectX 11 対応 GPU が必要

## ゼロコピー共有テクスチャレシーバー

- **Electron 40 以上が必要です** — `sharedTexture.importSharedTexture` / `sendSharedTexture` / `setSharedTextureReceiver` モジュールを使用します。それより古い Electron では import 時点で例外を投げます。
- **`listSenders()` に `<sender>_1` のような接尾辞が付く。** 同名の前回のセンダープロセスが正常終了せず、その共有メモリのディレクトリエントリが残っている状態です。実際のセンダーを起動（または再起動）してください — きれいな名前を再取得するか、次回の publisher サイクルで接尾辞付きのエントリが自然に消えます。
- **フレームごとのハンドルリーク（NT HANDLE 数 / IOSurface のメモリが増え続ける）。** `receiveSharedTexture()` を直接ポーリングする場合は、**すべての**経路で `closeNativeHandle(frame.handle)` をちょうど 1 回呼んでください。`sharedTexture.importSharedTexture` が成功した後も対象です（`importSharedTexture` はハンドルの所有権を引き取らず、自前で複製 / retain した参照を持ちます）。「ターゲットが破棄済み」「未知のピクセルフォーマット」「このフレームを破棄すると決めた」の経路も同様です。`createSharedTextureReceiver` はこれを自動的に行います。
- **Windows のステージングテクスチャ。** レシーバーはステージングテクスチャを `MISC_SHARED_NTHANDLE | MISC_SHARED`（キーミューテックスなし）で作成するため、consumer 側はフレームごとに `AcquireSync` を呼ぶ必要がありません — Electron が直接 import します。

## フリーズ / paint イベントが停止する

- **テクスチャ処理後は必ず `texture.release()` を呼ぶこと。** テクスチャプールは数フレーム分しかありません。release を呼ばないとプールが枯渇し、paint イベントパイプラインが停止します。
- `createTextureBridge()` 使用時は自動的に処理されます。
- 低レベルの core API 使用時は `try/finally` で確実に release を呼ぶ：

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
