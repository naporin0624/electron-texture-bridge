# Coding-Rules Compliance Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring all production TypeScript in `packages/core` and `packages/renderer` into compliance with the repo coding rules (arrow functions, no `let`, no `as`/`any`, explicit primitive conversion, exhaustive `switch`) with zero behavior change.

**Architecture:** Pure refactor. Each task touches a disjoint file set so tasks run in parallel in isolated git worktrees. A shared `toError()` helper (`packages/renderer/src/to-error.ts`) already exists on the base branch — tasks only consume it. Existing vitest suites are the safety net.

**Tech Stack:** TypeScript, tsdown, oxlint/oxfmt, tsgo (`pnpm typecheck`), vitest.

## Global Constraints

- **Zero behavior change.** This is a style/type-safety refactor only. Public API names, event ordering, and error messages must not change (except where a step explicitly says otherwise — there are none).
- Top-level functions: arrow syntax only (`const fn = (...) => {}`). `function` expressions allowed **only** where `this` binding is required (prototype patching in Task 1).
- `let` is forbidden. Use `const`, extracted helper functions, or a `const` object with mutated properties for genuinely mutable closure/module state.
- `as` casts forbidden in production code (`as const` is fine). Fix the model instead.
- Non-null assertion `!` forbidden.
- `String(x)` → `` `${x}` ``; `Number(x)` → `parseInt(x, 10)` / `parseFloat(x)`; never `Boolean(x)` / `!!`.
- Discriminated-union branching uses `switch` with a `default` that assigns to `never` inline (no `assertNever` helper).
- Baseline (must still hold after every task): `pnpm lint` = 0 errors (1 pre-existing warning about an empty file is OK), `pnpm typecheck` passes, core tests 9 passed, renderer tests 130 passed (126 + 4 new `to-error` tests on base).
- After each task: `pnpm lint && pnpm typecheck` from repo root, then the package's `pnpm test`. Commit with a conventional `refactor:` message.
- Do NOT touch `packages/example`, `packages/native`, test files (except where a step says so), or any file not listed in your task.
- Worktrees are fresh checkouts: run `pnpm install` once before anything else.

## Pre-existing shared helper (already on base branch — do not create)

`packages/renderer/src/to-error.ts`:

```typescript
export const toError = (value: unknown): Error => {
  if (value instanceof Error) return value;
  return new Error(`${value}`);
};
```

---

### Task 1: core package — remove `as any`, `Number()`, function declaration

**Files:**
- Modify: `packages/core/src/index.ts`
- Test (existing, unchanged): `packages/core/src/__tests__/index.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `sendTextureFromPaintEvent` keeps the exact same exported name and signature `(sender: InstanceType<typeof TextureSender>, textureInfo: TextureInfo | undefined) => void`.

- [ ] **Step 1: Run baseline tests**

Run: `pnpm -C packages/core test`
Expected: 9 passed.

- [ ] **Step 2: Replace the whole file body with the compliant version**

The three changes: (a) prototype patch no longer needs `as any` because the `declare module` augmentation below already types `[Symbol.dispose]` — a `function` expression with an explicit `this` parameter is required here (arrow functions cannot bind `this`); (b) `Number(bigint)` → `parseInt(`${bigint}`, 10)` (NT HANDLE values fit well under 2^53, so the string round-trip is lossless); (c) `export function` → `export const` arrow.

Final content of `packages/core/src/index.ts`:

```typescript
import {
  TextureSender,
  TextureReceiver,
  closeNativeHandle,
  getPlatform,
  listSenders,
} from "@napolab/texture-bridge";
import type {
  TextureInfo,
  PaintTexture,
  Platform,
  PixelFormat,
  SenderInfo,
  ReceivedFrame,
} from "./types";

// Attach Symbol.dispose to native classes so `using` declarations work.
// napi-rs cannot expose symbol-named methods, so we patch the prototypes here.
// `function` expressions (not arrows) are required for the `this` binding.
if (typeof Symbol.dispose === "symbol") {
  TextureSender.prototype[Symbol.dispose] = function (
    this: InstanceType<typeof TextureSender>,
  ) {
    this.stop();
  };
  TextureReceiver.prototype[Symbol.dispose] = function (
    this: InstanceType<typeof TextureReceiver>,
  ) {
    this.stop();
  };
}

// Augment native class types with Symbol.dispose (added at runtime above).
declare module "@napolab/texture-bridge" {
  interface TextureSender {
    [Symbol.dispose](): void;
  }
  interface TextureReceiver {
    [Symbol.dispose](): void;
  }
}

export { TextureSender, TextureReceiver, closeNativeHandle, getPlatform, listSenders };
export type { TextureInfo, PaintTexture, Platform, PixelFormat, SenderInfo, ReceivedFrame };
export type { SharedTextureFrame } from "@napolab/texture-bridge";

/**
 * Send a texture from an Electron paint event to Syphon/Spout.
 *
 * Handles platform detection and buffer extraction automatically.
 */
export const sendTextureFromPaintEvent = (
  sender: InstanceType<typeof TextureSender>,
  textureInfo: TextureInfo | undefined,
): void => {
  if (!textureInfo) return;
  const { handle, codedSize } = textureInfo;

  if (process.platform === "win32") {
    const ntHandle = handle.ntHandle;
    if (!ntHandle || !Buffer.isBuffer(ntHandle)) return;
    const handleValue = parseInt(`${ntHandle.readBigInt64LE(0)}`, 10);
    sender.send(handleValue, codedSize.width, codedSize.height);
    return;
  }

  if (process.platform === "darwin") {
    const ioSurface = handle.ioSurface;
    if (!ioSurface) return;
    sender.sendSurface(ioSurface, codedSize.width, codedSize.height);
  }
};
```

- [ ] **Step 3: Verify**

Run: `pnpm lint && pnpm typecheck && pnpm -C packages/core test`
Expected: lint 0 errors, typecheck passes, 9 tests passed.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "refactor(core): remove as-any casts, implicit Number coercion, function declaration"
```

---

### Task 2: renderer main-process trio — receiver.ts, discovery.ts, bridge.ts

**Files:**
- Modify: `packages/renderer/src/receiver.ts`
- Modify: `packages/renderer/src/discovery.ts`
- Modify: `packages/renderer/src/bridge.ts`
- Tests (existing, unchanged): `packages/renderer/src/__tests__/bridge.test.ts`, `packages/renderer/src/__tests__/discovery.test.ts`

**Interfaces:**
- Consumes: `toError(value: unknown): Error` from `./to-error` (already on base branch).
- Produces: `computeDipSize`, `buildBrowserWindowOptions`, `createTextureBridge`, `createTextureReceiver` keep identical exported names and signatures (now `const` arrows).

- [ ] **Step 1: Run baseline tests**

Run: `pnpm -C packages/renderer test`
Expected: 130 passed.

- [ ] **Step 2: receiver.ts — toError + arrow factory**

Add import at top: `import { toError } from "./to-error";`

Replace both occurrences of

```typescript
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
```

with

```typescript
      this.emit("error", toError(err));
```

Replace the factory declaration

```typescript
export function createTextureReceiver(
  options: TextureReceiverBridgeOptions,
): TextureReceiverBridge {
```

with

```typescript
export const createTextureReceiver = (
  options: TextureReceiverBridgeOptions,
): TextureReceiverBridge => {
```

(and the closing `}` of the function becomes `};`).

- [ ] **Step 3: discovery.ts — toError**

Add import at top: `import { toError } from "./to-error";`

In `_refresh()`, replace

```typescript
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    }
```

with

```typescript
    } catch (err) {
      this.emit("error", toError(err));
    }
```

- [ ] **Step 4: bridge.ts — toError, arrow functions, `let` removal**

Add import: `import { toError } from "./to-error";`

(a) In `handlePaint`, replace

```typescript
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
```

with

```typescript
      this.emit("error", toError(err));
```

(b) Convert `export function computeDipSize(...)` and `export function buildBrowserWindowOptions(...)` and `export async function createTextureBridge(...)` to `export const ... = (...) => {...}` arrows with unchanged parameter/return types (`createTextureBridge` stays `async`, returning `Promise<TextureBridge>`).

(c) In `createTextureBridge`, replace

```typescript
  let previewManager: PreviewManager | null = null;
  if (preview?.enabled !== false && preview) {
    previewManager = new PreviewManager(width, height, preview);
    previewManager.open();
  }
```

with

```typescript
  const previewManager =
    preview && preview.enabled !== false ? new PreviewManager(width, height, preview) : null;
  previewManager?.open();
```

(Equivalence: when `preview` is `undefined` both versions skip; when `preview.enabled === false` both skip; otherwise both construct and open.)

(d) Simplify the URL-loading chain (two identical `loadURL` branches):

```typescript
  const isUrlScheme =
    rendererUrl.startsWith("http://") ||
    rendererUrl.startsWith("https://") ||
    rendererUrl.startsWith("file://");
  if (isUrlScheme) {
    await renderWindow.loadURL(rendererUrl);
  } else {
    await renderWindow.loadFile(rendererUrl);
  }
```

- [ ] **Step 5: Verify**

Run: `pnpm lint && pnpm typecheck && pnpm -C packages/renderer test`
Expected: lint 0 errors, typecheck passes, 130 tests passed.

- [ ] **Step 6: Commit**

```bash
git add packages/renderer/src/receiver.ts packages/renderer/src/discovery.ts packages/renderer/src/bridge.ts
git commit -m "refactor(renderer): arrow factories, shared toError, drop let in bridge"
```

---

### Task 3: shared-texture-receiver.ts — `let` removal, switch exhaustiveness, cast removal

**Files:**
- Modify: `packages/renderer/src/shared-texture-receiver.ts`
- Test (existing, unchanged): `packages/renderer/src/__tests__/shared-texture-receiver.test.ts`

**Interfaces:**
- Consumes: `toError(value: unknown): Error` from `./to-error`.
- Produces: `createSharedTextureReceiver` keeps identical exported name and signature (now a `const` arrow).

- [ ] **Step 1: Run baseline tests**

Run: `pnpm -C packages/renderer test`
Expected: 130 passed.

- [ ] **Step 2: toError import + pixel-format guard without cast**

Add import: `import { toError } from "./to-error";`

Replace

```typescript
const isValidPixelFormat = (value: string): value is SharedTexturePixelFormat => {
  return (VALID_PIXEL_FORMATS as readonly string[]).includes(value);
};
```

with

```typescript
const isValidPixelFormat = (value: string): value is SharedTexturePixelFormat => {
  return VALID_PIXEL_FORMATS.some((format) => format === value);
};
```

- [ ] **Step 3: `_tick` — extract try/catch helpers, switch on SendResult**

Replace the whole `_tick` method body with:

```typescript
  private async _tick(): Promise<void> {
    if (this._disposed || this._inFlight) return;

    const frame = this._receiveFrame();
    if (!frame) return;

    const result = await this._sendTracked(frame);

    if (this._disposed) return;

    switch (result) {
      case "failed":
        // The error itself was already emitted inside `_send()`. Still count it
        // toward the circuit breaker so a stuck pipeline eventually stops.
        this._countTickError();
        return;
      case "skipped":
        // Not a failure (e.g. destroyed target during teardown). Don't touch the
        // error counter and don't tick FPS.
        return;
      case "delivered": {
        // Successful frame delivery — reset the consecutive-error counter.
        this._consecutiveErrors = 0;
        const fps = this.fpsCounter.tick();
        if (fps !== null) this.emit("fps", fps);
        return;
      }
      default: {
        const _exhaustive: never = result;
        throw new Error(`unhandled send result: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
```

Add these two private methods directly below `_tick` (keep the existing doc comment of `_tick` in place):

```typescript
  /**
   * Poll the native receiver once. Errors are recorded against the circuit
   * breaker and reported via the `"error"` event; both the no-frame and the
   * error case return `null` (the tick has nothing further to do either way).
   */
  private _receiveFrame(): SharedTextureFrame | null {
    try {
      return this.receiver.receiveSharedTexture();
    } catch (err) {
      this._recordTickError(toError(err));
      return null;
    }
  }

  /** Run `_send()` with the `_inFlight` drop-latest flag held for its duration. */
  private async _sendTracked(frame: SharedTextureFrame): Promise<SendResult> {
    this._inFlight = true;
    try {
      return await this._send(frame);
    } finally {
      this._inFlight = false;
    }
  }
```

- [ ] **Step 4: `_send` — extract import helper to remove `let imported`**

In `_send`, replace

```typescript
    let imported: Electron.SharedTextureImported;
    try {
      imported = sharedTexture.importSharedTexture({ textureInfo });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
      // importSharedTexture threw before taking ownership — release the handle
      // ourselves so we don't leak a per-frame NT HANDLE / IOSurface.
      releaseUnconsumedHandle(frame.handle);
      return "failed";
    }
```

with

```typescript
    const imported = this._importFrame(textureInfo, frame.handle);
    if (!imported) return "failed";
```

and add this private method below `_send`:

```typescript
  /**
   * Import one frame into Electron. On throw, emits the error, releases the
   * unconsumed native handle (importSharedTexture threw before taking
   * ownership — without this we leak a per-frame NT HANDLE / IOSurface), and
   * returns `null`.
   */
  private _importFrame(
    textureInfo: Electron.SharedTextureImportTextureInfo,
    rawHandle: Buffer,
  ): Electron.SharedTextureImported | null {
    try {
      return sharedTexture.importSharedTexture({ textureInfo });
    } catch (err) {
      this.emit("error", toError(err));
      releaseUnconsumedHandle(rawHandle);
      return null;
    }
  }
```

Also in `_send`'s final `try/catch` (around `sendSharedTexture`), replace

```typescript
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
```

with

```typescript
      this.emit("error", toError(err));
```

- [ ] **Step 5: factory → arrow**

Replace

```typescript
export function createSharedTextureReceiver(
  options: SharedTextureReceiverOptions,
): SharedTextureReceiverBridge {
```

with

```typescript
export const createSharedTextureReceiver = (
  options: SharedTextureReceiverOptions,
): SharedTextureReceiverBridge => {
```

(closing `}` → `};`).

- [ ] **Step 6: Verify**

Run: `pnpm lint && pnpm typecheck && pnpm -C packages/renderer test`
Expected: lint 0 errors, typecheck passes, 130 tests passed.

- [ ] **Step 7: Commit**

```bash
git add packages/renderer/src/shared-texture-receiver.ts
git commit -m "refactor(renderer): exhaustive SendResult switch, drop let/casts in shared-texture receiver"
```

---

### Task 4: preview-manager.ts — no arrow property, no `as`, no `!`, no `String()`

**Files:**
- Modify: `packages/renderer/src/preview-manager.ts`

**Interfaces:**
- Consumes: `TextureInfo` type from `@napolab/texture-bridge-core` (structurally assignable to `Electron.SharedTextureImportTextureInfo` — verified against electron@40.2.1 typings: same `pixelFormat` union, `codedSize`/`visibleRect` shapes, and optional-Buffer `handle`).
- Produces: `PreviewManager.sendFrame(texture: { textureInfo: TextureInfo })` — callers already pass `PaintTexture`, which satisfies this.

- [ ] **Step 1: Run baseline tests**

Run: `pnpm -C packages/renderer test`
Expected: 130 passed.

- [ ] **Step 2: Rewrite preview-manager.ts**

Changes: (a) `function assetPath` → arrow const; (b) the `onPreviewReady` arrow **property** becomes a method (`handlePreviewReady`) plus a per-open listener stored in a field, so `ipcMain.removeListener` still gets a stable reference (class methods must use method shorthand per repo rules); (c) `String(x)` → template literals; (d) `sendFrame` parameter typed with `TextureInfo` so the `as` cast disappears; (e) `updateSize` narrows `this.win` into a local instead of `this.win!`.

Final content of `packages/renderer/src/preview-manager.ts`:

```typescript
import { BrowserWindow, ipcMain, sharedTexture } from "electron";
import path from "path";
import type { TextureInfo } from "@napolab/texture-bridge-core";
import type { PreviewOptions } from "./types";

/**
 * Resolves asset paths relative to dist/assets/. `__dirname` is provided
 * natively in CJS output and injected via tsdown's `--shims` flag in ESM output
 * (see package.json build script), so this works in both module formats.
 */
const assetPath = (filename: string): string => {
  return path.join(__dirname, "assets", filename);
};

export class PreviewManager {
  private win: BrowserWindow | null = null;
  private ready = false;
  private width: number;
  private height: number;
  private title: string;
  private previewReadyListener: ((event: Electron.IpcMainEvent) => void) | null = null;

  constructor(width: number, height: number, options?: PreviewOptions) {
    this.width = width;
    this.height = height;
    this.title = options?.title ?? "Preview (GPU Zero-Copy)";
  }

  get window(): BrowserWindow | null {
    return this.win;
  }

  get isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  private handlePreviewReady(event: Electron.IpcMainEvent): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (event.sender.id !== this.win.webContents.id) return;
    this.ready = true;
  }

  private removePreviewReadyListener(): void {
    if (!this.previewReadyListener) return;
    ipcMain.removeListener("preview-ready", this.previewReadyListener);
    this.previewReadyListener = null;
  }

  open(): void {
    if (this.isOpen) return;

    this.ready = false;

    this.win = new BrowserWindow({
      width: Math.round(this.width / 2),
      height: Math.round(this.height / 2),
      title: this.title,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: assetPath("preview-preload.js"),
      },
    });

    const listener = (event: Electron.IpcMainEvent): void => {
      this.handlePreviewReady(event);
    };
    this.previewReadyListener = listener;
    ipcMain.on("preview-ready", listener);

    this.win.loadFile(assetPath("preview.html"), {
      query: { w: `${this.width}`, h: `${this.height}` },
    });

    this.win.on("closed", () => {
      this.win = null;
      this.ready = false;
      this.removePreviewReadyListener();
    });
  }

  sendFrame(texture: { textureInfo: TextureInfo }): void {
    if (!this.win || this.win.isDestroyed() || !this.ready) return;

    try {
      const imported = sharedTexture.importSharedTexture({
        textureInfo: texture.textureInfo,
      });
      if (!imported) return;

      sharedTexture
        .sendSharedTexture({
          frame: this.win.webContents.mainFrame,
          importedSharedTexture: imported,
        })
        .catch(() => {});
    } catch {
      // Ignore preview send errors
    }
  }

  updateSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    win.loadFile(assetPath("preview.html"), {
      query: { w: `${width}`, h: `${height}` },
    });
  }

  close(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.close();
    this.win = null;
    this.ready = false;
  }

  dispose(): void {
    this.removePreviewReadyListener();
    this.close();
  }
}
```

Note: if `tsgo` reports that `texture.textureInfo` is not assignable to `Electron.SharedTextureImportTextureInfo`, STOP and report the exact error instead of re-adding a cast.

- [ ] **Step 3: Verify**

Run: `pnpm lint && pnpm typecheck && pnpm -C packages/renderer test`
Expected: lint 0 errors, typecheck passes, 130 tests passed.

- [ ] **Step 4: Commit**

```bash
git add packages/renderer/src/preview-manager.ts
git commit -m "refactor(renderer): rule-compliant PreviewManager (no arrow property, cast, non-null assertion)"
```

---

### Task 5: client — shared-texture-consumer.ts, client/index.ts

**Files:**
- Modify: `packages/renderer/src/client/shared-texture-consumer.ts`
- Modify: `packages/renderer/src/client/index.ts`
- Tests (existing, unchanged): `packages/renderer/src/__tests__/shared-texture-consumer.test.ts`

**Interfaces:**
- Consumes: `toError(value: unknown): Error` from `../to-error` (tsdown bundles it into the client entry).
- Produces: `installSharedTextureReceiver`, `consumeSharedTexture`, `_resetSharedTextureRegistryForTesting`, `createWorkerRenderer` keep identical exported names and signatures.

- [ ] **Step 1: Run baseline tests**

Run: `pnpm -C packages/renderer test`
Expected: 130 passed.

- [ ] **Step 2: shared-texture-consumer.ts — module `let` flags → const state object, toError**

Add import: `import { toError } from "../to-error";`

Replace

```typescript
let receiverInstalled = false;
let notInstalledWarningShown = false;
```

with

```typescript
/** Module-level install state. Mutable via property writes (repo bans `let`). */
const installState = {
  receiverInstalled: false,
  notInstalledWarningShown: false,
};
```

Then update every reference:
- In `installSharedTextureReceiver`: `if (installState.receiverInstalled) return;` and `installState.receiverInstalled = true;`
- In `consumeSharedTexture`: `if (!installState.receiverInstalled && !installState.notInstalledWarningShown) { installState.notInstalledWarningShown = true; ... }`
- In `_resetSharedTextureRegistryForTesting`: `installState.receiverInstalled = false; installState.notInstalledWarningShown = false;`

Replace

```typescript
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
```

with

```typescript
        handlers.onError?.(toError(err));
```

- [ ] **Step 3: client/index.ts — arrow factory, `let lastW/lastH` → const object**

Replace

```typescript
export function createWorkerRenderer(options: WorkerRendererOptions): WorkerRendererHandle {
```

with

```typescript
export const createWorkerRenderer = (options: WorkerRendererOptions): WorkerRendererHandle => {
```

(closing `}` → `};`).

Replace

```typescript
  let lastW = width;
  let lastH = height;

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width: w, height: h } = entry.contentRect;
      const rw = Math.round(w);
      const rh = Math.round(h);
      if (rw === lastW && rh === lastH) continue;
      lastW = rw;
      lastH = rh;
      const msg: MainToWorkerMessage = { type: "resize", width: rw, height: rh };
      worker.postMessage(msg);
    }
  });
```

with

```typescript
  const lastSize = { width, height };

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width: w, height: h } = entry.contentRect;
      const rw = Math.round(w);
      const rh = Math.round(h);
      if (rw === lastSize.width && rh === lastSize.height) continue;
      lastSize.width = rw;
      lastSize.height = rh;
      const msg: MainToWorkerMessage = { type: "resize", width: rw, height: rh };
      worker.postMessage(msg);
    }
  });
```

- [ ] **Step 4: Verify**

Run: `pnpm lint && pnpm typecheck && pnpm -C packages/renderer test`
Expected: lint 0 errors, typecheck passes, 130 tests passed.

- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/client/shared-texture-consumer.ts packages/renderer/src/client/index.ts
git commit -m "refactor(renderer/client): drop module-level let, arrow factory, shared toError"
```

---

## Out of Scope

- `packages/example` (private demo app; worker-global `let` state is a larger redesign).
- Test files' `as unknown as` mock casts and `let` fixtures — standard vitest mock patterns; churning them adds risk without production value.
- `packages/native` (Rust/C++).

## Integration (orchestrator)

After all 5 task branches complete: merge each into `refactor/coding-rules-compliance`, run `pnpm lint && pnpm typecheck && pnpm -C packages/core test && pnpm -C packages/renderer test`, expect 9 + 130 passed, then `pnpm build` as a final smoke check.
