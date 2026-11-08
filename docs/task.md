# やりたいこと

- [ ] `installXXX(): void` のように副作用だけを起こす API をやめ、副作用の場所が見える API にする。最初の対象は `installSharedTextureReceiver` で、`bindSharedTextureReceiver(sharedTexture)` が `{ consume, dispose }` を返す形にする（[plan](superpowers/plans/2026-11-01-bind-shared-texture-receiver.md)）
- [ ] 内部の preview window（`packages/renderer` の `preview-preload.js`）が `sharedTexture.setSharedTextureReceiver` を直接呼んでいる。`bindSharedTextureReceiver(sharedTexture).consume(...)` に寄せる（別 PR）
- [ ] `packages/example/src/main/index.ts` 150 行目付近のコメント「`createSharedTextureReceiver` は poll する」を直す。実際は mac/win では push がデフォルト（別 PR）
- [ ] example のマルチビューアが他のウィンドウに隠れると rAF が止まって描画されなくなる。`backgroundThrottling: false` などで、隠れていても描画を続けるようにする（別 PR）
- [x] `receiveFrame()` が mac / win の両方で RGBA の順に返すことを、Rust の cargo test で確かめる（`send_rgba` で既知の色を送り `receive_rgba` で読む）。platform-smoke（workflow_dispatch）で実行する。#101 のマージ前に別 PR として作り、マージまで Windows では失敗する
- [ ] `spout_bridge.cpp` の BGRA→RGBA 変換を 1 つの helper にまとめ、`spout_receiver_receive_rgba` と `read_mapped_preview` の両方から使う。BGRA かどうかの判定もそろえる（#109）
