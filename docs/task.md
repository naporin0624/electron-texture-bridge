# やりたいこと

- [ ] `installXXX(): void` のように副作用だけを起こす API をやめ、副作用の場所が見える API にする。最初の対象は `installSharedTextureReceiver` で、`bindSharedTextureReceiver(sharedTexture)` が `{ consume, dispose }` を返す形にする（[plan](superpowers/plans/2026-11-01-bind-shared-texture-receiver.md)）
- [ ] 内部の preview window（`packages/renderer` の `preview-preload.js`）が `sharedTexture.setSharedTextureReceiver` を直接呼んでいる。`bindSharedTextureReceiver(sharedTexture).consume(...)` に寄せる（別 PR）
- [ ] `packages/example/src/main/index.ts` 150 行目付近のコメント「`createSharedTextureReceiver` は poll する」を直す。実際は mac/win では push がデフォルト（別 PR）
- [ ] example のマルチビューアが他のウィンドウに隠れると rAF が止まって描画されなくなる。`backgroundThrottling: false` などで、隠れていても描画を続けるようにする（別 PR）
