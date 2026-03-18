# Breaking Change Notes: 明示的なネイティブ解放

このドキュメントでは、native sender / receiver の解放を GC 任せの挙動から明示的な disposal に切り替えることで発生する breaking changes を説明します。

## 概要

今後は JavaScript のガベージコレクションに依存して native GPU / IPC リソースがいつか解放される、という前提をやめます。

代わりに以下の挙動になります。

- `TextureSender.stop()` は native リソースを即時解放する
- `TextureReceiver.stop()` は native リソースを即時解放する
- 上位の `dispose()` は終端操作として決定的に動作する
- `stop()` 済みの sender / receiver を使うと明示的なエラーになる

TypeScript のシグネチャが大きく変わらなくても、挙動としては breaking change です。

## 変更理由

従来のモデルは、以下のような native リソースの解放タイミングを GC に委ねていました。

- Syphon server / client handle
- Spout sender / receiver handle
- GPU バックの native object

この方式は解放タイミングが不定で、長時間動作する Electron アプリでは shutdown 時の挙動を読みづらくします。

新しいモデルでは所有権を明確にします。

- create -> use -> stop / dispose -> 再利用不可

## 影響を受けるパッケージ

- `@napolab/texture-bridge`
- `@napolab/texture-bridge-core`
- `@napolab/texture-bridge-renderer`

## Breaking Changes

### 1. `stop()` は終端操作になる

変更前:

- API 上は `stop()` が存在していても、実際の native resource 解放は GC タイミングに依存しうる
- `stop()` 後の再利用が、たまたま動いて見える可能性がある

変更後:

- `stop()` は native resource を即時 drop する
- `stop()` 後、そのオブジェクトは永続的に closed 状態になる
- `stop()` の複数回呼び出しは安全かつ idempotent であるべき

### 2. `stop()` 後の利用は無効になる

この変更後、停止済みオブジェクトへの操作は許容されません。

例:

- `TextureSender.send(...)` を `stop()` 後に呼ぶ
- `TextureSender.sendSurface(...)` を `stop()` 後に呼ぶ
- `TextureSender.sendRgbaBuffer(...)` を `stop()` 後に呼ぶ
- `TextureReceiver.receiveFrame()` を `stop()` 後に呼ぶ
- `TextureReceiver.hasNewFrame()` を `stop()` 後に呼ぶ

新しい期待挙動:

- `"TextureSender has been stopped"` や `"TextureReceiver has been stopped"` のような明確なエラーで決定的に失敗する

### 3. `dispose()` が本当の teardown 境界になる

`@napolab/texture-bridge-renderer` の高レベルラッパーは、単に timer を止めたり、いずれ GC されるオブジェクトに処理を委譲するだけではなくなります。

変更後:

- `TextureBridge.dispose()` は sender 側の teardown を完了させる必要がある
- `TextureReceiverBridge.dispose()` は receiver 側の teardown を完了させる必要がある
- `dispose()` 済みオブジェクトは再利用不可になる

### 4. これまで表面化していなかったライフサイクル misuse が runtime error として見えるようになる

現状、次のような使い方に依存しているアプリは影響を受ける可能性があります。

- `stop()` の後に同じオブジェクトを使い続ける
- `dispose()` を呼ばなくても、いずれ GC されるからよいとみなす
- 古い sender / receiver を明示的に閉じずに新しいものへ置き換える

明示解放を入れると、こうしたパターンは失敗するようになります。

## Migration Guide

### Sender

変更前:

```ts
const sender = new TextureSender("MyApp", 1920, 1080);
sender.stop();

// 以前は見かけ上動くことがあっても、今後は無効
sender.send(handle, 1920, 1080);
```

変更後:

```ts
const sender = new TextureSender("MyApp", 1920, 1080);

try {
  sender.send(handle, 1920, 1080);
} finally {
  sender.stop();
}
```

ルール:

- `stop()` を呼んだらそのインスタンスは破棄し、必要なら新しく作り直す

### Receiver

変更前:

```ts
const receiver = new TextureReceiver("MySender");
receiver.stop();

// 変更後は無効
receiver.receiveFrame();
```

変更後:

```ts
const receiver = new TextureReceiver("MySender");

try {
  const frame = receiver.receiveFrame();
} finally {
  receiver.stop();
}
```

ルール:

- `stop()` を呼んだらそのインスタンスは破棄し、必要なら新しく作り直す

### 高レベル Renderer API

変更前:

```ts
const bridge = await createTextureBridge(...);
bridge.dispose();

// 再利用できる前提で扱わない
bridge.resize(1280, 720);
```

変更後:

```ts
const bridge = await createTextureBridge(...);
bridge.dispose();

// dispose 済み bridge を再利用せず、新しく作り直す
```

## 利用側で推奨される変更

- constructor と teardown を常にペアで扱う
- `stop()` / `dispose()` を終端操作として扱う
- native resource 解放を GC に依存しない
- stop 済みオブジェクトを蘇生せず、sender / receiver / bridge を作り直す
- アプリ終了経路で確実に close されることをテストする

## 互換性メモ

- `stop()` / `dispose()` の複数回呼び出しは引き続き安全であるべき
- 主な breaking change はシグネチャよりも挙動面にある
- これまで黙って許容されていたライフサイクル misuse が明示的に失敗するようになる
- このライブラリをさらにラップしている場合は、そのラッパー側の lifecycle contract も揃える必要がある

## リリースノート用の短い要約

> Native sender / receiver の解放が明示的かつ決定的になりました。`stop()` と `dispose()` は終端操作であり、停止済みオブジェクトは再利用できません。
