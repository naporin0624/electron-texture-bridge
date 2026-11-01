# bindSharedTextureReceiver — 副作用を明示する受信 API

## Goal

`installSharedTextureReceiver(): void` + `consumeSharedTexture(handlers)` の 2 関数構成をやめる。新しい構成は `bindSharedTextureReceiver(sharedTexture)` で、これは `{ consume, dispose }` を持つハンドルを返す。

- 副作用（Electron の単一スロット `setSharedTextureReceiver` の書き換え）は `bind` の呼び出し 1 箇所に集約し、書き換え対象は引数で注入する
- `consume` をハンドルのメソッドにして、「install 前に consume」という状態を型で書けなくする
- モジュールレベルの `let` / グローバル dispatcher / `_resetSharedTextureRegistryForTesting` を削除する

破壊的変更（`feat!:`）。`bump-minor-pre-major: true` なので 0.16.0 → 0.17.0 になる。

## 決定事項（ユーザー確認済み）

| 項目                 | 決定                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------ |
| API 形状             | `bindSharedTextureReceiver(sharedTexture)` → `{ consume(handlers), dispose() }`      |
| 依存                 | `sharedTexture` を引数で注入（型は `Pick<Electron.SharedTexture, "setSharedTextureReceiver">` 相当） |
| 二重 bind            | 同じ注入オブジェクトに 2 回 bind したら名前付き Error class を throw する。dispose 後の再 bind は可   |
| dispose 後の consume | 名前付き Error class を throw する                                                    |
| 旧 API               | 削除（deprecated で残さない）                                                         |

## Design

```ts
export interface SharedTextureReceiverTarget {
  setSharedTextureReceiver: Electron.SharedTexture["setSharedTextureReceiver"]; // electron.d.ts で実際の interface 名を確認
}

export interface BoundSharedTextureReceiver {
  consume(handlers: SharedTextureConsumerHandlers): SharedTextureConsumerRegistration;
  dispose(): void; // 冪等
}

export const bindSharedTextureReceiver = (
  target: SharedTextureReceiverTarget,
): BoundSharedTextureReceiver => { ... };
```

- `createMultiDispatcher` は bind ごとに 1 つ作り、ハンドルの closure に持たせる
- 二重 bind の検出はモジュールレベルの `WeakSet<SharedTextureReceiverTarget>` で行い、注入されたオブジェクトをキーにする。`dispose()` で set から外す
- `dispose()` は dispatcher を reset し、bound フラグを立てて以降の `consume` を throw にする。Electron には解除 API がないので、設置済みの callback は残し、release だけを行う drain として動かし続ける。再 bind したときは Electron の last-wins で差し替わる
- Error class は `packages/renderer/src/errors.ts` の既存パターンに合わせて追加する（例: `SharedTextureReceiverAlreadyBoundError`, `SharedTextureReceiverDisposedError`）。`errors.ts` 内の既存 class の書き方（name 設定など）を踏襲する
- **ホットパスの挙動は変えない**: macrotask 遅延の `imported.release()`、double-release の swallow、`videoFrame.close()` の finally、`onError` が throw したときの耐性は、そのまま移植する（PR #89 で計測済みの経路）
- 「install 前の consume」の `console.warn` は表現できない状態になるので削除する

## Tasks

### Task 1: renderer core（TDD）

- `packages/renderer/src/__tests__/shared-texture-consumer.test.ts` を新 API で書き直す。fake は `{ setSharedTextureReceiver: vi.fn() }` を各テストで生成し、`vi.mock("electron")` に依存しない
  - 既存の不変条件をすべて維持する: 全 consumer の settle 後に release が 1 回だけ／release の遅延／consumer 0 件でも drain する／consumer ごとの VideoFrame／onError の隔離／double-release への耐性
  - 追加: 二重 bind で throw、dispose 後の再 bind が成功、dispose 後の consume で throw、dispose の冪等性、dispose 後に届いたフレームも release される
  - 削除: warn テスト
- `shared-texture-consumer.ts` を実装し、`errors.ts` に Error class を追加する
- `client/index.ts`: 旧 2 名を削除し、`bindSharedTextureReceiver` と型（`BoundSharedTextureReceiver`, `SharedTextureReceiverTarget`）、Error class を export する（errors の既存 export 経路を確認する）

### Task 2: example app + コメント参照

- `packages/example/src/preload/receiver.ts`, `multiviewer.ts`: `import { sharedTexture } from "electron"` に変え、`const receiver = bindSharedTextureReceiver(sharedTexture); receiver.consume(...)` の形にする
- コメント内の参照を更新する: `packages/renderer/src/types.ts:200`, `packages/core/src/electron.ts:64`, `packages/example/src/main/index.ts:168`

### Task 3: docs + plugin skills

- `docs/API.md`, `docs/RECEIVING.md`, `docs/ja/API.md`, `docs/ja/RECEIVING.md`, `README.md`, `lang/ja/README.md`
- `plugins/texture-bridge/skills/receiving-shared-textures/SKILL.md`（127 行目の「受信 API はちょうど install + consume」というガードも書き換える）、`migrating-to-forward-frames`, `choosing-texture-bridge-api`, `diagnosing-dead-frame-forwards`
- `docs/superpowers/plans/*`, `specs/*` は過去の記録なので触らない

### 完了条件

`pnpm lint && pnpm typecheck && pnpm test` が通ること。`git grep -n "installSharedTextureReceiver\|consumeSharedTexture"` の結果が `docs/superpowers/` 以外で 0 件になること。
