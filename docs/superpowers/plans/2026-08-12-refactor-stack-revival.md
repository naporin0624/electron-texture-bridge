# Refactor Stack Revival（旧 #58–#64 の再スコープ 5 PR）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2026-07-15 の stacked refactor PR #58–#64（unmerged で close 済み）のうち現 main（cca64cd 以降）でも有効な内容を、監査（2026-08-12）の適応指示に従って 5 本の新 PR として順に再実装する。

**Architecture:** 各タスク = 1 ブランチ = 1 PR。**旧 PR の diff（`gh pr diff <n>`）が一次ソース**で、各タスクの「適応リスト」が現 main との差分を埋める。旧ブランチの rebase は禁止（#67/#69/#70 のシグネチャ変更を跨げない）。タスクは直列（2→3→4 は同一ファイル依存）。

**Tech Stack:** pnpm / vitest / tsgo / oxlint+oxfmt / neverthrow（Task 1・4 で各パッケージに導入）

## Global Constraints

- 各タスク開始時: `git fetch origin main && git checkout main && git pull --ff-only origin main` → タスク記載のブランチ名で分岐
- 一次ソース: `gh pr view <n> --json title,body` と `gh pr diff <n>`（closed でも取得可能）。**そのまま適用せず、必ず適応リストを通す**
- 確立済みの決定（違反したら差し戻し）:
  - **neverthrow の Result を公開 API から返さない**。内部のみ、`.match` で edge 消費。`Result.fromThrowable` は **module-scope の named const** に束縛（inline IIFE 禁止）
  - **slot-object パターン禁止**: module/関数レベルの単純な再代入は plain `let` を維持（let-ban-pragmatism）。`lastW/lastH`・`render-worker` の `worker` オブジェクト化は**採用しない**
  - error class は throw 境界を跨ぐものだけ
  - top-level は arrow、class メソッドは shorthand
- `sendTextureFromPaintEvent` の現シグネチャは `(sender, textureInfo) => PaintDefect | undefined`（#67）。`dispose()` は同期 `destroy()`（#70）。`createTextureBridge` は `createTextureBridgeWith` の束縛 const（#70）
- 各タスク完了時 `pnpm lint && pnpm typecheck` + 対象パッケージの test。コミットに CLAUDE.md / tasks.md / AGENTS.md を含めない
- 各タスクの最後: difit でユーザーレビュー → **OK をもらってから** push + PR 作成 → ユーザーの merge を待って次タスクへ

---

### Task 1: refactor(core) — rules compliance + TextureSendError（旧 #58 + #64 統合）

**Branch:** `refactor/core-rules-send-error` / **PR title:** `refactor(core): rules compliance + TextureSendError via fromThrowable`

**Source:** `gh pr diff 58`, `gh pr diff 64`

**適応リスト（監査より）:**
- [ ] `packages/core/src/index.ts` の `(TextureSender.prototype as any)[Symbol.dispose] = function () {...}` ×2 を型付きで置換（`function(this: InstanceType<typeof TextureSender>)` — prototype 代入は `this` が必要なので arrow 不可。func-style ルールの sanctioned exception としてコメントを付す）
- [ ] platform dispatch を if-chain → `switch (process.platform)`（exhaustive ではない — default が `unsupported-platform` defect）
- [ ] `sendTextureFromPaintEvent` を arrow const 化（旧 #58 の変換を新シグネチャに適用）。**各 guard 分岐は `PaintDefect` を返す**（void 時代の bare return にしない）
- [ ] `packages/core/src/errors.ts` を新規作成: `TextureSendError extends Error`（message 保持 + `cause` 保持。旧 #64 の実装を踏襲）
- [ ] native throw 点（`sender.send` / `sender.sendSurface`）**のみ** module-scope named `Result.fromThrowable` 経由にし、`.match` の err 側で `TextureSendError` を throw。ok 側は `undefined` を返す。**Result は export しない**
- [ ] `packages/core/package.json` に `neverthrow` 追加、`tsconfig.json` lib に `ES2022.Error`（旧 #64 と同じ）
- [ ] `Number(ntHandle.readBigInt64LE(0))` は **BigInt→number 変換であり type-coercion ルール（文字列変換）の対象外** — 旧 #58 が別形に変えていても現行行を維持する
- [ ] テスト: 既存 14 件維持 + `TextureSendError` ラップ検証（非 Error throw の cause 保持含む）。旧 #64 のテストを新シグネチャに適応
- [ ] core build → `pnpm lint && pnpm typecheck` → core/renderer 両 test（renderer は dist 型依存）

---

### Task 2: refactor(renderer) — toError + arrow cleanup（旧 #59 + #61 有効分）

**Branch:** `refactor/renderer-toerror-arrows` / **PR title:** `refactor(renderer): shared toError helper + arrow-style cleanup`

**Source:** `gh pr diff 59`, `gh pr diff 61`

**適応リスト:**
- [ ] `packages/renderer/src/to-error.ts` 新規（旧 #59 のものを流用）
- [ ] `err instanceof Error ? err : new Error(String(err))` の生パターン全 8+ 箇所を `toError(err)` に置換: `bridge.ts`（handlePaint catch）、`discovery.ts`、`receiver.ts` ×2、`shared-texture-receiver.ts` ×3、`client/shared-texture-consumer.ts`
- [ ] arrow const 化: `computeDipSize` / `buildBrowserWindowOptions` / `createTextureReceiver` / `createSharedTextureReceiver` / `createWorkerRenderer`（export 名・シグネチャ不変）
- [ ] `createTextureBridgeWith` 内の `let previewManager` → const ternary（旧 #59 の変換を現在の関数位置に適用）
- [ ] URL スキーム if/else チェーン（http/https/file → loadURL、else → loadFile）を収束（http・https・file は同じ `loadURL` 呼びなので条件を 1 つに）
- [ ] **`client/index.ts` の `lastW`/`lastH` は plain `let` のまま触らない**（slot-object 化 DROP）
- [ ] テスト: 挙動不変なので既存 162 件が green のまま。toError の単体テストを追加（Error 素通し / 非 Error ラップ + cause）

---

### Task 3: refactor(renderer) — SendResult switch + PreviewManager 準拠（旧 #60）

**Branch:** `refactor/renderer-receiver-preview` / **PR title:** `refactor(renderer): exhaustive SendResult switch + rule-compliant PreviewManager`

**Source:** `gh pr diff 60`（監査で現 main にほぼ verbatim 適用可と確認済み）。Task 2 マージ後に分岐（toError 依存）。

**適応リスト:**
- [ ] `shared-texture-receiver.ts`: `let frame`/`let result`/`let imported` の解消、`SendResult` の if-chain → exhaustive `switch`（inline `never` default）、`_receiveFrame`/`_sendTracked`/`_importFrame` 抽出、`(VALID_PIXEL_FORMATS as readonly string[]).includes(...)` → cast-free `isValidPixelFormat` ガード
- [ ] `preview-manager.ts`: `onPreviewReady =` arrow property → method shorthand + stored listener 参照、`this.win!` → narrowed local、`String(this.width)` → template literal、`sendFrame` の `as Electron.SharedTextureImportTextureInfo` cast 除去（`TextureInfo` 型受け）
- [ ] テスト: 既存 green 維持 + 旧 #60 が持っていたテストがあれば新構造に適応

---

### Task 4: refactor(renderer) — 内部 neverthrow 採用（旧 #62）

**Branch:** `refactor/renderer-neverthrow` / **PR title:** `refactor(renderer): internal neverthrow adoption with typed error classes`

**Source:** `gh pr diff 62`（named fromThrowable binding 済みで現行スキル準拠と監査確認済み）。Task 2・3 マージ後に分岐。

**適応リスト:**
- [ ] `packages/renderer/src/errors.ts`: `FrameReceiveError` / `TextureImportError` / `TextureDeliveryError` / `UnsupportedPixelFormatError` / `ReceiverStoppedError`（error class は throw/イベント境界を跨ぐもののみ）
- [ ] `packages/renderer/package.json` に `neverthrow`、tsconfig lib に `ES2022.Error`
- [ ] `shared-texture-receiver.ts` の `_validate` → `_prepare` → `_deliver` Result chain、`discovery.ts` の `safeListSenders`、`preview-manager.ts` の import→send chain — すべて module-scope named binding、`.match` で edge 消費
- [ ] **公開 API 不変**（Result を export しない。新規 export は error class のみ）
- [ ] テスト: 既存 green 維持 + error class 変換パスのテスト

---

### Task 5: refactor(example) — demo app 準拠（旧 #63、slot-object 置換）

**Branch:** `refactor/example-rules` / **PR title:** `refactor(example): coding-rules compliance for the demo app`

**Source:** `gh pr diff 63`。他タスクと独立（main から分岐、Task 1–4 のマージを待たなくてよいが、順序どおりなら最後）。

**適応リスト:**
- [ ] `main/index.ts`: `getRendererUrl` / `bootstrap` の arrow 化。`let activeReceiver` / `let activeBridge` は **plain let のまま**
- [ ] `preload/receiver.ts`: `getElement<T>`（instanceof ガード）で 6 箇所の `as HTMLXElement | null` cast を置換、`(err as Error)` → `instanceof Error` ガード
- [ ] `render-worker.ts`: **旧 diff の `worker = { context: null as ..., ... }` slot-object は採用しない** — `let context: RenderContext | null = null;` の単一 plain let に置き換えて他の let を統合。`WorkerEvent` の exhaustive `switch` と arrow 化は採用
- [ ] example は test なし → `pnpm lint && pnpm typecheck` + example 起動スモーク（起動 → fps → 必ず kill）

---

## 実装しないこと

- 旧ブランチ（origin の refactor/*）の rebase・再 open
- slot-object パターンの復活（監査 DROP 2 件）
- 公開 API への Result 露出
