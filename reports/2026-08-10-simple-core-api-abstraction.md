# Simple Usage / Core Usage API の抽象化 — Genovese / Cannelloni 調査に基づく再設計レポート

- 日付: 2026-08-10
- 調査対象:
  - `~/ghq/github.com/naporin0624/Genovese`（VJ システム。texture-bridge 0.13.1 消費者）
  - `~/ghq/github.com/naporin0624/Cannelloni`（Electron アプリ。texture-bridge 0.13.0 消費者、patch 適用中）
  - 本リポジトリ `electron-texture-bridge`（packages/core, packages/renderer）
- 目的: 両アプリの API 層構造を抽象化し、texture-bridge の **simple usage（高レベル）/ core usage（低レベル）二層 API 再設計**の土台にする
- 重点スキル: `prefix-match-processor`（dispatch 構造）, `precise-type-modeling`（型モデリング）

---

## 1. 三リポジトリの現状マップ

| | simple usage（推奨経路） | core usage（合成可能な primitive） | 境界（seam） |
|---|---|---|---|
| **texture-bridge** | `createTextureBridge(options)` — 窓・paint 配線・DPR・preview を**所有** | `TextureSender` / `TextureReceiver` / `sendTextureFromPaintEvent` — Electron 任意、`sendRgbaBuffer` は素の Node で動く | package 境界（`-renderer` → `-core`）+ README の decision tree |
| **Genovese** | `composition-singleton` / `compositorBridge` singleton → `createCompositionSession(deps)` | `createCompositorKernel(plugins)` + 17 個の `createXxxPlugin(deps)` + pure 関数群（`compositor-core`） | `CompositorPlugin` interface + `commandPrefixes` prefix dispatch + type-only `ports/*.ts` |
| **Cannelloni** | `createDeck` — `createTextureBridge` をさらに包む facade（`ResultAsync<Deck, Error>`） | texture-bridge core は**診断ツール専用**（`scripts/syphon-check.ts` の `sendRgbaBuffer`） | `createDeckWith(createBridge: typeof createTextureBridge)` — factory 注入 seam |

**観察 1: 三者とも「二層 + seam」の同型構造。** 差は seam の表現（package 境界 / path alias + port 型 / factory 注入）だけ。

**観察 2: 実アプリは本番経路で simple tier しか使わない。** Cannelloni の本番 `deck.ts` は `createTextureBridge` のみ。core（`sendRgbaBuffer`）は「Electron 無しの切り分けツール」として使われる。Genovese も本番送出は `createTextureBridge`（`texture-bridge-setup.ts`）、core の `TextureReceiver` は受信サービス内部でのみ直接使用。→ **simple tier が製品、core tier は escape hatch + 診断**という役割分担が消費者側の実態。

---

## 2. 抽象モデル: 二層 API の構造

3 リポジトリに共通する構造を抽象化すると次の 4 層になる。

```
┌────────────────────────────────────────────────────────────┐
│ L1: Recommended Entry（simple usage）                       │
│   createTextureBridge / createDeck / composition-singleton  │
│   ・リソース（窓・worker・native handle）を「所有」する      │
│   ・プラットフォーム差（DPR, ESM, paint 形状）を「吸収」する │
│   ・返すのは Handle: commands + events + readonly state      │
│     + dispose / Symbol.dispose                               │
├────────────────────────────────────────────────────────────┤
│ L2: Facade Assembly（配線のみの層）                          │
│   assembleDeck / createCompositionSession / bridge.ts 内部   │
│   ・primitive を組み立てるだけ。ロジックは持たない            │
│   ・Deps 注入 seam（createXxxWith）はこの層に置く            │
├────────────────────────────────────────────────────────────┤
│ L3: Primitives（core usage）                                 │
│   TextureSender / CompositorPlugin / orchestrator / pure fn  │
│   ・単一責任。呼び出し側のリソースを所有しない                │
│   ・単体でテスト可能。Electron 非依存が理想                   │
├────────────────────────────────────────────────────────────┤
│ L4: Platform Boundary（外部境界）                            │
│   native addon / Electron paint event / Worker / Vendor SDK  │
│   ・unknown が到着する唯一の場所。即座に concrete 型へ parse │
└────────────────────────────────────────────────────────────┘
```

### 各層の契約

**L1（simple）の契約 — 「所有と吸収」**
- リソースのライフサイクルを factory が全所有する（Genovese `.claude/rules/headless-app-pattern.md` の言い方では factory → closure state → subscribe → getters → commands → dispose）
- プラットフォーム quirk はここで吸収する（texture-bridge の `pixelExact`、Cannelloni の `force-device-scale-factor` 判断はこの層の責務）
- Handle の形: `{ コマンド(void/Promise); on/subscribe; readonly 状態; dispose(); [Symbol.dispose]() }`

**L2（assembly）の契約 — 「配線のみ」**
- Genovese の `createCompositionSession` header comment が最も明瞭: *"Creates … Builds … NOT responsible for: subscriptions / event routing"*。**自分の入力を自分で subscribe しない**。配線は使用地点（singleton / アプリ側）で明示的に行う
- テスト用 seam はここ。Cannelloni の `createDeckWith(createBridge: typeof createTextureBridge)` は texture-bridge がそのまま採用できるパターン:

```ts
// L2 に置く注入 seam。テストは fake bridge を注入できる
export const createTextureBridgeWith =
  (deps: TextureBridgeDeps) =>
  async (options: TextureBridgeOptions): Promise<TextureBridge> => { /* 配線のみ */ };

export const createTextureBridge = createTextureBridgeWith({
  createWindow: (o) => new BrowserWindow(o),
  createSender: (name, w, h) => new TextureSender(name, w, h),
});
```

**L3（core）の契約 — 「所有しない・吸収しない」**
- README の DPR 警告が示す通り、core は DPR を吸収**しない**。これはバグではなく契約 — ただし契約は型とドキュメントで明示する（§4 参照）
- Electron 非依存で動く部分（`sendRgbaBuffer`）は最強の切り分けツールとして両アプリで実証済み。この性質は保護すべき公開契約

**L4（boundary）の契約 — 「unknown は通過点」**
- `precise-type-modeling` rule 2: 外部から来る値（Electron の paint event、native の返り値）は到着直後に concrete 型へ分類し、失敗は**モデル化された defect** にする（§4.2）

### Options / Deps の分離（Genovese house style の一般化）

| | 中身 | 例 |
|---|---|---|
| `XxxOptions` | **値**（設定・寸法・名前） | `{ name, width, height, frameRate?, pixelExact? }` |
| `XxxDeps` | **協力者**（注入可能な実装） | `{ createWindow, createSender, discovery? }` |

texture-bridge の現行 `TextureBridgeOptions` は値のみでこの規約に適合済み。欠けているのは Deps 側（factory がすべて内部 import）で、Cannelloni がテストのために `createDeckWith` を自作した事実が需要の証拠。

---

## 3. Dispatch 構造の抽象化（prefix-match-processor 観点）

両アプリには **`Result<Match, PassThrough>` を契約とする first-match chain が計 5 実装**あり、すべて同じ形に収束している。

### 3.1 観測された 3 variant

**Variant A: Result 契約の first-match chain（skill の canonical 形）**
Cannelloni の toast / MIDI decode、Genovese・Cannelloni 両方の intent router。

```ts
// 契約: ok = 自分が処理した（short-circuit）/ err(入力そのまま) = 次へ
type Processor<In, Out> = {
  readonly id: string;
  readonly run: (input: In) => Result<Out, In>;
};
// runner は再帰 first-match。registry は配列順 = 優先度（specific first）
```

**Variant B: 宣言的 prefix map + 最長一致 + 構築時衝突検査**
Genovese の compositor kernel。plugin が `commandPrefixes: readonly string[]` を宣言し、kernel が:
1. 構築時に prefix 衝突を throw（`"effect/" claimed by both X and Y`）
2. `sort((a, b) => b.length - a.length)` で**最長 prefix 優先**を機械化（skill の「specific first」を並び順の人為ミスから解放）
3. dispatch は `startsWith` 一致した plugin の `onCommand` に委譲、suffix の `switch` は plugin 内部

**Variant C: phantom rest parameter による registry 網羅性のコンパイル時検査**
両アプリの intent router が同一実装:

```ts
export const createIntentRouter = <const Routes extends readonly IntentRoute[]>(
  routes: Routes,
  ..._exhaustive: Exclude<IntentNamespace, Routes[number]['id']> extends never
    ? []
    : [missingRoutesFor: Exclude<IntentNamespace, Routes[number]['id']>]
): ((intent: Intent) => Result<IntentWork, Intent>) => ...
```

route を 1 個消すと**呼び出し側が型エラーになり、欠けた namespace 名がエラーメッセージに現れる**。

### 3.2 使い分けの抽象規則

| 条件 | 選ぶ形 |
|---|---|
| ≤ ~5 家族 & 各分岐 1 行 | inline `switch`（抽出は premature — skill の閾値） |
| 家族集合が**閉じた union**（`Intent['type']` から導出可能） | Variant A + C: Result chain + phantom param で網羅性検査 |
| 家族集合が**開いている**（plugin が後から追加され、union を中央で持てない） | Variant B: 宣言的 prefix + 最長一致 + 衝突検査 |

### 3.3 texture-bridge への適用

- 現行の worker protocol（`{ type: "init" | "resize" | "dispose" }` の 3 variant）は**閾値未満。inline switch のままが正しい**
- ただし今後 command 家族が増える場合（例: `sender/`, `receiver/`, `preview/`, `worker/` の名前空間で bridge 制御コマンドを拡張する場合）は Variant A+C を採用する。texture-bridge の command 集合はライブラリが中央で定義する閉じた union なので、Genovese kernel 型（開集合向け）より **intent router 型（閉集合向け）が適合**
- `createMultiDispatcher`（現行 renderer/client）は「1 upstream → 全 consumer に fan-out」であり、first-match chain とは**直交する別パターン**。統合しないこと。両者の区別を型名で明示する価値がある: `MultiDispatcher`（fan-out, 全員に配る）vs `ProcessorChain`（first-match, 1 人が引き取る）

---

## 4. 型モデリングの抽象化（precise-type-modeling 観点）

### 4.1 現行 texture-bridge の型で rule 違反になっている箇所

**`TextureInfo.handle` — optional 2 連は collapsed union（rule 4 違反）**

```ts
// 現行: どちらも optional。両方 undefined / 両方 Buffer が型上表現可能
handle: {
  ntHandle?: Buffer;   // Windows
  ioSurface?: Buffer;  // macOS
};
```

これは Electron の paint event をそのまま写した boundary 型なので、**入口はこの形で受けてよいが、rule 2 に従い到着直後に分類する**:

```ts
/** L4 → L3 の入口で分類した結果。impossible state を排除する */
type ClassifiedHandle =
  | { readonly platform: "win32"; readonly ntHandle: Buffer }
  | { readonly platform: "darwin"; readonly ioSurface: Buffer };

/** 分類失敗も throw ではなくモデル化された defect にする */
type PaintDefect =
  | { readonly reason: "no-texture" }
  | { readonly reason: "no-nt-handle" }
  | { readonly reason: "no-io-surface" };

const classifyPaintTexture = (
  texture: PaintTexture | undefined,
  platform: NodeJS.Platform,
): Result<ClassifiedHandle, PaintDefect> => { ... };
```

これは Cannelloni が worktree `fix-win-spout-diagnostics` で**ライブラリの外側に自作した** `paintTextureDefect()`（`'no-texture' | 'no-nt-handle' | 'no-io-surface'` 分類）の取り込みに相当する。消費者が診断のために逆向きに実装した = ライブラリ側にあるべき型だった、という強い証拠。

**Silent drop の廃止（defect union の出口）**

Cannelloni の Win10 調査レポートが名指しした 2 箇所 — renderer `handlePaint()` の `if (!texture?.textureInfo) return;` と core win32 の `if (!ntHandle || ...) return;` — は無言 return で、受信側には「黒画面」としてしか観測できない。上の `PaintDefect` union をそのまま event に流す:

```ts
interface BridgeEvents {
  // 既存: fps, ready, error, disposed, resize
  frameDropped: [defect: PaintDefect];  // 追加。error とは別チャンネル（正常系の no-op も含むため）
}
```

Cannelloni の `MidiSkipReason`（「これは失敗ではなく正常な no-op」を tagged 型で表す）と同じ設計判断。**drop は error ではないが観測可能でなければならない。**

**`SenderInfo` の optional（`appName?`, `uuid?`）**
プラットフォーム依存の optional。頻度・実害が低いので優先度は下がるが、platform tag 付き union 化が筋。

**`PaintTexture.release?`**
Electron 40–41（optional）と 42+（必須）のバージョン差を optional で表している。型 1 本で全バージョンを覆うのは不可能なので、これは現状維持が妥当（README の version note で契約明示済み）。

### 4.2 エラーチャンネルの層別規約

Genovese / Cannelloni と既存メモリ（neverthrow-api-boundary: **Result は internal-only、edge で `.match`**）から、層ごとのエラー表現規約を抽象化できる:

| 層 | エラー表現 | 根拠 |
|---|---|---|
| L1 公開 API | `void` + throw（error class）+ `error` / `frameDropped` event | Result を公開 API に出さない（neverthrow-api-boundary）。PR #64 で確立済み |
| L2 / L3 内部 | `Result` / `ResultAsync`（module-scope named `fromThrowable` binding） | PR #65/#66 で確立済み。chain 契約は `Result<Match, PassThrough>` |
| 正常系 no-op | error にせず tagged union（`PaintDefect`, `MidiSkipReason` 型） | 「失敗」と「処理対象外」の混同を防ぐ |
| throw 境界を跨ぐもののみ | `class extends Error` | Genovese は React error boundary を跨ぐ 1 箇所だけ class（`CompositorFailureError`）。texture-bridge の `TextureSendError` も同判断 |

### 4.3 イベントの型モデル: tuple map vs event union

- texture-bridge（現行）: `BridgeEvents = { fps: [number]; ready: []; ... }` + generic `on<K>` — EventEmitter idiom
- Genovese: `subscribe(cb: (event: EventUnion) => void)` — union + `switch` で網羅性検査が効く

**推奨: 公開 L1 は現行 tuple map を維持**（Electron エコシステムの idiom、既存消費者互換）。**内部 seam（L2↔L3、worker protocol）は event union + subscribe** に寄せる。discriminated union なら受信側の `switch` に variant 追加漏れがコンパイルエラーとして現れる — tuple map ではイベント名追加が消費者側で静かに無視される。

### 4.4 型の導出規約

- 公開 Handle 型（`TextureBridge`）: 明示 interface を維持（ドキュメント性、JSDoc の付着点）
- 内部 assembly の型: `export type Xxx = ReturnType<typeof createXxx>`（Genovese house style）で導出し、二重定義を避ける
- 派生 surface は演算で導出: Genovese の `CompositionProxy = Omit<CompositionManager, ...> & {...}`、port 型（コマンド union の最小 subset を type-only で切り出し、L2 が L3 の全体ではなく必要面だけに依存する）は texture-bridge の `/client` サブパスの型設計に転用可能

---

## 5. ドキュメント構造の抽象化

両アプリの一次資料から、simple/core 二層ドキュメントの必須要素が抽出できる:

1. **Decision tree は「誰がリソースを所有するか」で分岐させる**（現 README の "Which API should I use?" は Cannelloni の doc-feedback §2 の要望通りで正しい。維持）
2. **役割テーブル + 依存方向図**（renderer → core → native → platform-binary）。Cannelloni doc-feedback §1 が要望。※ `texture-bridge-core` の package.json description が *"High-level GPU texture sharing"* になっているのは実バグ（低レベル package なのに High-level と自称）— 要修正
3. **拡張の complexity 段階表**: Genovese `effect-system.md` の Pattern A（3 ファイルのレシピ、plugin 不要）/ B / C（plugin 自作）→ Low/Medium/High 比較表という構成は、texture-bridge の「simple で足りるか core に降りるか」ガイドの雛形になる
4. **プラットフォーム quirk は simple tier の吸収機能として文書化し、core tier では「吸収しない」と明記**（DPR 警告の現構成は正しい）

---

## 6. texture-bridge 再設計 backlog（優先度順）

調査から直接導かれる具体タスク。上 3 つは消費者が現に踏んでいる実バグ/実需要。

> **進捗（2026-08-12 時点）**: #1 = 0.13.1 で修正済みだった（回帰ガードを PR #67 で追加）/ #2 = PR #67（`PaintDefect` + `frameDropped` + `droppedReason`）/ #3 = PR #69（OSR scale policy — 正体は Electron 42 の OSR scale 1.0 化。`reports/2026-08-11-pixelexact-osr-scale-investigation.md`）/ #4 = #2 のガード分岐実装で実質消化 / #5・#6・#7 = PR #70（`createTextureBridgeWith` / 同期 `destroy()` / description + 依存方向図）/ **#8 = 棚卸しの結果クローズ** — 内部 seam は既に union ベース（worker protocol の message union、multi-dispatcher の lifecycle event union）で、唯一のコールバック object `SharedTextureConsumerHandlers` は単一 variant（union 化の閾値未満）。公開面の tuple map は §4.3 の方針どおり維持 / #9 = 設計どおり保留（command family > 5 まで）。残: Windows 実機での display scaling 検証（要 Windows 機）。

| # | 項目 | 出典 | 規模 |
|---|---|---|---|
| 1 | ~~ESM `__dirname` バグ修正~~ **→ 0.13.1 で修正済み**（`tsdown.config.mts` の `shims: true`、commit df76799 / 8c06ba6）。Cannelloni の patch は 0.13.0 固定に当てたもの。残作業: (a) shim 消失を防ぐ回帰テスト（本 repo）、(b) Cannelloni の 0.13.1 アップグレード + patch 撤去（消費者側） | Cannelloni `patches/@napolab__texture-bridge-renderer@0.13.0.patch` / renderer CHANGELOG 0.13.1 | 小 |
| 2 | **silent drop の event 化**: `classifyPaintTexture` + `frameDropped: [PaintDefect]` event（§4.1） | Cannelloni win10 調査レポート / diagnostics worktree | 中 |
| 3 | **`pixelExact` の再検証**: OSR shared-texture が device scale 1.0 で描画される環境では `computeDipSize` が逆効果（1920→実質 960）。Cannelloni は削除して `force-device-scale-factor=1` へ移行、Genovese は使用継続。どの環境で正しく働くかの契約明確化 + `width/height` が "pixels" と文書化されつつ DIP として渡される契約不一致（Genovese AGENTS.md 指摘）の解消 | Cannelloni `reports/2026-06-17-*.md` / Genovese `AGENTS.md:47` | 中〜大 |
| 4 | `TextureInfo.handle` の内部分類 union 化（#2 の前提。公開型は Electron 互換のまま） | §4.1 | 小 |
| 5 | `createTextureBridgeWith(deps)` seam の公開（テスト用 factory 注入） | Cannelloni `createDeckWith` | 小 |
| 6 | `dispose()` と `before-quit` の競合: `renderWindow.close()`（async）では SIGKILL に間に合わずクラッシュダイアログが出る。`destroy()` を含む同期 teardown の提供 or 文書化 | Genovese `texture-bridge-setup.ts:92-99` / Cannelloni `deck.ts:120-124`（両者が独立に同じ workaround） | 小 |
| 7 | core package description 修正（"High-level" → 低レベルの正しい説明）+ 依存方向図の README 追加 | Cannelloni doc-feedback §1 | 小 |
| 8 | 内部 seam のイベントを union + subscribe に寄せる（worker protocol から段階適用） | §4.3 | 中 |
| 9 | command 家族が 5 を超えた時点で intent-router 型 processor chain 導入（それまでは着手しない） | §3.3 | 保留 |

---

## 付録: 抽象モデルの型スケッチ（seam 契約の全体像）

```ts
// ── L1: simple usage の Handle 契約 ─────────────────────────
interface BridgeEvents {
  fps: [fps: number];
  ready: [];
  error: [error: Error];
  frameDropped: [defect: PaintDefect];   // 追加（§4.1）
  disposed: [];
  resize: [width: number, height: number];
}

interface TextureBridge {
  on<K extends keyof BridgeEvents>(event: K, listener: (...args: BridgeEvents[K]) => void): this;
  resize(width: number, height: number): void;
  readonly renderWindow: BrowserWindow;
  readonly isDisposed: boolean;
  dispose(): void;
  [Symbol.dispose](): void;
}

// ── L2: assembly の注入 seam ────────────────────────────────
interface TextureBridgeDeps {
  createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
  createSender: (name: string, width: number, height: number) => TextureSender;
}
declare const createTextureBridgeWith: (
  deps: TextureBridgeDeps,
) => (options: TextureBridgeOptions) => Promise<TextureBridge>;

// ── L3/L4 境界: boundary 分類（unknown は通過点） ───────────
type ClassifiedHandle =
  | { readonly platform: "win32"; readonly ntHandle: Buffer }
  | { readonly platform: "darwin"; readonly ioSurface: Buffer };

type PaintDefect =
  | { readonly reason: "no-texture" }
  | { readonly reason: "no-nt-handle" }
  | { readonly reason: "no-io-surface" };

declare const classifyPaintTexture: (
  texture: PaintTexture | undefined,
  platform: NodeJS.Platform,
) => Result<ClassifiedHandle, PaintDefect>;

// ── 将来の dispatch seam（family > 5 になったら。§3.3） ────
interface Processor<In, Out> {
  readonly id: string;
  run(input: In): Result<Out, In>;   // ok = 引き取った / err(input) = 次へ
}
```
