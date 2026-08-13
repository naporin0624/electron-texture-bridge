# DI Seam + Sync Dispose + Package Docs（backlog #5/#6/#7）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (#6) `dispose()` の teardown を `close()`（async）→ `destroy()`（sync）に変更して before-quit の SIGKILL 競合を根治、(#5) `createTextureBridgeWith(deps)` のテスト用注入 seam を公開、(#7) core の package description 修正 + README に依存方向図を追加。

**Architecture:** #6 はオーナー決定済み — offscreen の hidden window に `close()` のライフサイクル配慮は不要で、Genovese / Cannelloni が独立に同じ `destroy()` workaround を実装した事実がデフォルトの誤りの証拠。#5 は Cannelloni の `createDeckWith(createBridge)` パターンの texture-bridge 版: `TextureBridgeDeps = { createWindow, createSender }` を curried factory で注入し、`resize()` の sender 再構築も同じ `createSender` を通す（`TextureBridgeImpl` ctor 第 6 引数・デフォルト付きで既存呼び出し無変更）。#7 は Cannelloni doc-feedback §1 への対応。

**Tech Stack:** pnpm / vitest / tsgo / oxlint+oxfmt。electron mock は既存 bridge.test.ts のものを拡張。

## Global Constraints

- ベースは **main**（#69 マージ済み、04dfe8a 以降）。`git fetch origin main && git pull --ff-only origin main` してから分岐
- ブランチ名: `feat/di-seam-sync-dispose`
- 各タスク完了時 `pnpm lint && pnpm typecheck`（tsc 直接実行禁止）
- コミットは本計画のステップでのみ。CLAUDE.md / tasks.md / AGENTS.md（untracked）を含めない。push は指示待ち
- 既存の `function` 宣言スタイルは触らない（未マージ PR #58–#64 との衝突最小化）。ただし #5 で `createTextureBridge` は `createTextureBridgeWith` から導出する const arrow に**置き換える**（これは機能変更であり style 変更ではない。シグネチャ・JSDoc は維持）
- `dispose()` の `destroy()` 化は**挙動変更**: fix(renderer) として conventional commit。README / JSDoc の説明も同期
- 実装完了後 difit でレビュー依頼（Task 4）

## File Structure

| ファイル | 役割 |
|---|---|
| `packages/renderer/src/bridge.ts` | #6 dispose の destroy 化、#5 `TextureBridgeDeps` + `createTextureBridgeWith` + ctor 第 6 引数 + resize の注入 sender |
| `packages/renderer/src/types.ts` | #6 `dispose()` JSDoc 更新 |
| `packages/renderer/src/index.ts` | #5 `createTextureBridgeWith` / `TextureBridgeDeps` の公開 |
| `packages/renderer/src/__tests__/bridge.test.ts` | mock 拡張（destroy）+ #6/#5 テスト |
| `packages/core/package.json` | #7 description 修正 |
| `README.md` / `lang/ja/README.md` | #6 dispose 記述更新、#7 依存方向図 + 役割テーブル |

---

### Task 1: #6 — dispose() を destroy() に変更

**Files:**
- Modify: `packages/renderer/src/bridge.ts`（`dispose()`、186–189 行付近）
- Modify: `packages/renderer/src/types.ts`（`dispose()` JSDoc）
- Test: `packages/renderer/src/__tests__/bridge.test.ts`

**Interfaces:**
- Produces: `dispose()` が `renderWindow.close()` の代わりに `renderWindow.destroy()` を呼ぶ（同期・キャンセル不可）。他の teardown 順序（sender.stop → previewManager.dispose → emit "disposed" → removeAllListeners）は不変

- [ ] **Step 1: 失敗するテストを書く**

(a) electron mock の `MockBrowserWindow` を拡張 — `close` を assert 可能な `vi.fn()` プロパティにし、`destroy` を追加:

```typescript
    close = vi.fn();
    destroy = vi.fn();
```

（既存の `close(): void {}` method shorthand は削除して property に置き換える。`isDestroyed()` はそのまま）

(b) ファイル末尾に describe を追加:

```typescript
describe("TextureBridgeImpl.dispose — synchronous teardown", () => {
  it("destroys the render window synchronously instead of close()", () => {
    const win = new BrowserWindow();
    const bridge = new TextureBridgeImpl(win, new TextureSender("t", 16, 9), null, baseOpts);

    bridge.dispose();

    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(win.close).not.toHaveBeenCalled();
    expect(bridge.isDisposed).toBe(true);
  });

  it("is idempotent", () => {
    const win = new BrowserWindow();
    const bridge = new TextureBridgeImpl(win, new TextureSender("t", 16, 9), null, baseOpts);

    bridge.dispose();
    bridge.dispose();

    expect(win.destroy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer test -- bridge
```

Expected: FAIL — `destroy` が呼ばれず `close` が呼ばれる

- [ ] **Step 3: 実装**

`dispose()` 内（bridge.ts）:

```typescript
    // Destroy the offscreen window synchronously. `close()` is async and
    // cancellable — it loses the race against `before-quit`, letting Chromium
    // SIGKILL the OSR renderer and pop a crash dialog. Both known consumers
    // independently worked around this by forcing `destroy()`; a hidden
    // offscreen window has no user-facing close semantics to honor.
    if (!this._renderWindow.isDestroyed()) {
      this._renderWindow.destroy();
    }
```

`packages/renderer/src/types.ts` の `dispose()` JSDoc を更新:

```typescript
  /**
   * Tear down all resources synchronously. The offscreen window is
   * `destroy()`ed (not `close()`d) so teardown cannot lose the race against
   * `before-quit` — no separate `renderWindow.destroy()` workaround is needed.
   * Terminal operation — the bridge cannot be reused afterward.
   */
  dispose(): void;
```

- [ ] **Step 4: テストが通ることを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer test
```

Expected: PASS（全件 — 既存の disposed 系テストも destroy mock で通る）

- [ ] **Step 5: lint / typecheck**

```bash
pnpm lint && pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/renderer/src/bridge.ts packages/renderer/src/types.ts packages/renderer/src/__tests__/bridge.test.ts
git commit -m "fix(renderer): destroy the offscreen window synchronously in dispose()"
```

---

### Task 2: #5 — createTextureBridgeWith(deps) seam

**Files:**
- Modify: `packages/renderer/src/bridge.ts`
- Modify: `packages/renderer/src/index.ts`
- Test: `packages/renderer/src/__tests__/bridge.test.ts`

**Interfaces:**
- Consumes: Task 1 完了後の bridge.ts
- Produces:
  - `interface TextureBridgeDeps { createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow; createSender: (name: string, width: number, height: number) => InstanceType<typeof TextureSender>; }`（export）
  - `createTextureBridgeWith(deps: TextureBridgeDeps): (options: TextureBridgeOptions) => Promise<TextureBridge>`（export、公開 index からも）
  - `createTextureBridge` は `createTextureBridgeWith({ 実デフォルト })` から導出（シグネチャ・JSDoc 維持）
  - `TextureBridgeImpl` ctor 第 6 引数 `createSender: TextureBridgeDeps["createSender"] = (name, width, height) => new TextureSender(name, width, height)` — `resize()` の 2 箇所の `new TextureSender(...)` を `this.createSender(...)` に置き換え

- [ ] **Step 1: 失敗するテストを書く**

```typescript
describe("createTextureBridgeWith — dependency injection seam", () => {
  it("routes window and sender construction through the injected deps", async () => {
    const createWindow = vi.fn(
      (options: Electron.BrowserWindowConstructorOptions) => new BrowserWindow(options),
    );
    const createSender = vi.fn(
      (name: string, width: number, height: number) => new TextureSender(name, width, height),
    );

    const bridge = await createTextureBridgeWith({ createWindow, createSender })(baseOpts);

    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(createWindow.mock.calls[0]?.[0]?.webPreferences?.offscreen).toBeDefined();
    expect(createSender).toHaveBeenCalledWith("test", 1920, 1080);

    bridge.resize(1280, 720);
    expect(createSender).toHaveBeenCalledWith("test", 1280, 720);
  });
});
```

import 行に `createTextureBridgeWith` を追加。

- [ ] **Step 2: テストが失敗することを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer test -- bridge
```

Expected: FAIL — `createTextureBridgeWith` 未 export

- [ ] **Step 3: 実装**

(a) `TextureBridgeDeps` を定義（`buildBrowserWindowOptions` の近く）:

```typescript
/**
 * Injectable constructors for {@link createTextureBridgeWith}. Lets tests and
 * embedders swap the BrowserWindow / native sender without faking Electron
 * globals (the pattern consumers previously built themselves as
 * `createDeckWith(createBridge)`).
 */
export interface TextureBridgeDeps {
  createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
  createSender: (name: string, width: number, height: number) => InstanceType<typeof TextureSender>;
}
```

(b) `TextureBridgeImpl` に第 6 引数を追加:

```typescript
  private readonly createSender: TextureBridgeDeps["createSender"];

  constructor(
    renderWindow: BrowserWindow,
    sender: InstanceType<typeof TextureSender>,
    previewManager: PreviewManager | null,
    options: TextureBridgeOptions,
    policy: OsrScalePolicy = resolveOsrScalePolicy(resolveElectronMajor(process.versions)),
    createSender: TextureBridgeDeps["createSender"] = (name, width, height) =>
      new TextureSender(name, width, height),
  ) {
```

`resize()` の 2 箇所（forward / rollback）の `new TextureSender(...)` を `this.createSender(...)` に置き換える。

(c) 既存 `createTextureBridge`（async function 宣言）を次の 2 export に置き換える。**既存の JSDoc は `createTextureBridgeWith` 側へ移し、`createTextureBridge` には「デフォルト deps 束縛版」の 1 行 JSDoc を付ける**:

```typescript
export const createTextureBridgeWith =
  (deps: TextureBridgeDeps) =>
  async (options: TextureBridgeOptions): Promise<TextureBridge> => {
    // …既存 createTextureBridge の本体をそのまま移植し、
    //   new BrowserWindow(...) → deps.createWindow(...)
    //   new TextureSender(name, width, height) → deps.createSender(name, width, height)
    //   new TextureBridgeImpl(renderWindow, sender, previewManager, options, policy)
    //     → new TextureBridgeImpl(renderWindow, sender, previewManager, options, policy, deps.createSender)
  };

/** {@link createTextureBridgeWith} bound to the real BrowserWindow / TextureSender. */
export const createTextureBridge = createTextureBridgeWith({
  createWindow: (options) => new BrowserWindow(options),
  createSender: (name, width, height) => new TextureSender(name, width, height),
});
```

(d) `packages/renderer/src/index.ts` に追加:

```typescript
export { createTextureBridgeWith } from "./bridge";
export type { TextureBridgeDeps } from "./bridge";
```

- [ ] **Step 4: テストが通ることを確認**

```bash
pnpm --filter @napolab/texture-bridge-renderer test
```

Expected: PASS（既存の createTextureBridge 系テストも同一挙動で通る）

- [ ] **Step 5: lint / typecheck**

```bash
pnpm lint && pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/renderer/src/bridge.ts packages/renderer/src/index.ts packages/renderer/src/__tests__/bridge.test.ts
git commit -m "feat(renderer): expose createTextureBridgeWith dependency-injection seam"
```

---

### Task 3: #7 — core description 修正 + README 依存方向図

**Files:**
- Modify: `packages/core/package.json`（description）
- Modify: `README.md`（「Which API should I use?」直後に依存方向図、`dispose` 記述の整合）
- Modify: `lang/ja/README.md`（ミラー）

**Interfaces:**
- Consumes: Task 1（dispose 挙動）/ Task 2（新 export）

- [ ] **Step 1: core package.json の description 修正**

```diff
-  "description": "High-level GPU texture sharing for Electron (Spout + Syphon Metal)",
+  "description": "Low-level GPU texture sharing primitives for Electron (Spout + Syphon Metal): TextureSender/TextureReceiver + paint-event helpers",
```

- [ ] **Step 2: README EN — 依存方向図 + 役割テーブル**

`## Which API should I use?` セクションの直後に追加:

```markdown
### Package roles and dependency direction

```
@napolab/texture-bridge-renderer   High-level factory API (recommended): createTextureBridge,
        │                          receivers, discovery, preview
        ▼
@napolab/texture-bridge-core       Low-level primitives: TextureSender / TextureReceiver,
        │                          sendTextureFromPaintEvent — Electron optional
        ▼
@napolab/texture-bridge            Native addon (napi-rs binding)
        │
        ▼
@napolab/texture-bridge-darwin-arm64 / -darwin-x64 / -win32-x64-msvc
                                   Prebuilt platform binaries (installed automatically)
```
```

- [ ] **Step 3: README EN — dispose 記述の整合**

`TextureBridge` API ref の `dispose()` 行、および Migration: Explicit Disposal 節に古い「`renderWindow.close()`（async, cancellable）」前提の記述があれば、Task 1 の新挙動（同期 `destroy()`、before-quit workaround 不要）に合わせて更新する。`createTextureBridgeWith` を API Reference の `createTextureBridge` 直後に 1 エントリ追加:

```markdown
#### `createTextureBridgeWith(deps)` (advanced)

Returns `createTextureBridge` bound to injected constructors
(`{ createWindow, createSender }`) — for tests and embedders that need to swap
the `BrowserWindow` or native sender without faking Electron globals.
```

- [ ] **Step 4: lang/ja/README.md に対応 3 箇所をミラー**

EN の挿入（依存方向図・dispose 更新・createTextureBridgeWith エントリ）を対応位置に自然な日本語で反映。

- [ ] **Step 5: 検証**

```bash
pnpm lint && pnpm typecheck && pnpm --filter @napolab/texture-bridge-core test && pnpm --filter @napolab/texture-bridge-renderer test
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json README.md lang/ja/README.md
git commit -m "docs: correct core package role and add dependency-direction diagram"
```

（package.json の description は docs 扱いだが release-please のパス検知対象。`docs:` は release をトリガーしないため、リリースには Task 1 の `fix(renderer):` / Task 2 の `feat(renderer):` が乗る — 問題なし）

---

### Task 4: 検証 + 最終レビュー + difit

- [ ] **Step 1: フルビルド + 全テスト**

```bash
pnpm --filter @napolab/texture-bridge-core build && pnpm --filter @napolab/texture-bridge-renderer build
pnpm lint && pnpm typecheck && pnpm --filter @napolab/texture-bridge-core test && pnpm --filter @napolab/texture-bridge-renderer test
```

- [ ] **Step 2: 実機スモーク（dispose 変更の確認）**

example を起動 → fps 確認 → **終了させて**クラッシュダイアログが出ないこと（destroy 経路）を確認 → 必ず process kill。

- [ ] **Step 3: difit でレビュー依頼**

```bash
npx difit HEAD main
```

**push / PR 作成は指示を待つ。**

---

## 実装しないこと（スコープ外）

- `PreviewManager` の注入（YAGNI — 消費者需要の実績がない）
- backlog #8（内部 seam の event union 化）/ #9（processor chain）
- Windows 実機検証（#3 の残課題として別トラック）
