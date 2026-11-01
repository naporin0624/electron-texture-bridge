# やりたいこと

- [ ] `installXXX(): void` のように副作用だけを起こす API をやめ、副作用の場所が見える API にする。最初の対象は `installSharedTextureReceiver` で、`bindSharedTextureReceiver(sharedTexture)` が `{ consume, dispose }` を返す形にする（[plan](superpowers/plans/2026-11-01-bind-shared-texture-receiver.md)）
