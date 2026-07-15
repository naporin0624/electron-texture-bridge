# Phase 2: neverthrow + New-Skill Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the newly added project skills — `chaining-neverthrow-results`, `modeling-errors-as-classes`, `switch-pattern` — to the public packages (internal implementation only, zero public-API breakage), and bring `packages/example` into coding-rules compliance.

**Architecture:** neverthrow is adopted **internally** in `@napolab/texture-bridge-renderer`: throwing Electron/native calls are wrapped once with `Result.fromThrowable` / `ResultAsync.fromPromise`, errors ride a typed class union, and `.match` collapses exactly at the consumption edge (the `"error"` event emit / SendResult return). Public APIs (EventEmitter events, throwing factories) are unchanged; emitted errors become subclasses of `Error` with identical messages. Base branch already carries the prep commit (neverthrow dep, `errors.ts`, lib tweak).

**Tech Stack:** TypeScript, neverthrow, tsdown, oxlint/oxfmt, tsgo, vitest.

## Global Constraints

- **Zero public-API breakage.** Emitted error **messages must stay byte-identical** (tests assert them, e.g. `"native boom"`, `"import failed badly"`, `/stopped after 10 consecutive errors/`, `"Native error"`). Wrapping is allowed only in the message-preserving form `new XError(toError(cause).message, { cause })`.
- neverthrow style per `chaining-neverthrow-results`: compose with `.andThen/.map/.mapErr/.orElse`, ONE `.match` at the consumption edge (= where we `emit("error", ...)` or produce the outside-world value). No `_unsafeUnwrap`, no `isErr()` unwrapping mid-flow, no `safeTry`.
- Error classes per `modeling-errors-as-classes`: `class XError extends Error { override name = "XError" }`, discriminate with `instanceof` (never `switch (error.name)`). Already created on base: `packages/renderer/src/errors.ts`.
- All phase-1 rules still apply (arrow functions only, no `let`, no `as` in production code, `` `${x}` `` not `String()`, exhaustive `switch` with inline `never` default for OUR modeled unions).
- Baseline (must hold after every task): `pnpm lint` 0 errors (1 pre-existing warning OK), `pnpm typecheck` passes, core tests 9 passed, renderer tests ≥ 130 passed (prep adds error-class tests on top).
- Worktree recipe: `pnpm install` → `pnpm build:core && pnpm build:renderer` (fresh worktrees have no dist; tsgo needs the d.ts of upstream packages) → work → verify.
- Verify command per task: `pnpm lint && pnpm typecheck && pnpm -C packages/renderer test` (Task C also runs core tests; Task D has no test suite — lint+typecheck only for example).
- Run `pnpm exec oxfmt --write <changed files>` before committing. Do NOT commit `CLAUDE.md` or `AGENTS.md`.
- Do not touch files outside your task's list.

## Prep (already on base branch — do not redo)

1. `pnpm add neverthrow --filter @napolab/texture-bridge-renderer`
2. `packages/renderer/tsconfig.json` lib gains `"ES2022.Error"` (for `Error` `{ cause }` options; runtime is Electron 40 / Node 22, both support it).
3. `packages/renderer/src/errors.ts`:

```typescript
/**
 * Error classes for the renderer package's error channel (see
 * .claude/skills/modeling-errors-as-classes). `name` is a stable wire/log
 * discriminator; in-process discrimination uses `instanceof`. Errors that
 * wrap a caught value MUST preserve the original message
 * (`new XError(toError(cause).message, { cause })`) — the public error
 * events are asserted by message in the test suite.
 */

/** The native receiver's `receiveSharedTexture()` threw. */
export class FrameReceiveError extends Error {
  override name = "FrameReceiveError";
}

/** Electron's `importSharedTexture` threw before taking handle ownership. */
export class TextureImportError extends Error {
  override name = "TextureImportError";
}

/** Electron's `sendSharedTexture` rejected. */
export class TextureDeliveryError extends Error {
  override name = "TextureDeliveryError";
}

/** A frame arrived with a pixel format Electron cannot import. */
export class UnsupportedPixelFormatError extends Error {
  override name = "UnsupportedPixelFormatError";
  constructor(pixelFormat: string, expected: readonly string[]) {
    super(
      `shared texture frame has unsupported pixelFormat "${pixelFormat}" (expected one of ${expected.join(", ")})`,
    );
  }
}

/** Circuit breaker: too many consecutive tick errors; the receiver stopped itself. */
export class ReceiverStoppedError extends Error {
  override name = "ReceiverStoppedError";
  constructor(limit: number) {
    super(`shared texture receiver stopped after ${limit} consecutive errors`);
  }
}

/** Union of every failure the shared-texture send pipeline can produce. */
export type SendPipelineError =
  | UnsupportedPixelFormatError
  | TextureImportError
  | TextureDeliveryError;
```

4. `packages/renderer/src/index.ts` additionally re-exports the classes:

```typescript
export {
  FrameReceiveError,
  TextureImportError,
  TextureDeliveryError,
  UnsupportedPixelFormatError,
  ReceiverStoppedError,
} from "./errors";
export type { SendPipelineError } from "./errors";
```

5. `packages/renderer/src/__tests__/errors.test.ts` (message-format regression tests).

---

### Task A: shared-texture-receiver.ts — neverthrow send pipeline

**Files:**
- Modify: `packages/renderer/src/shared-texture-receiver.ts`
- Tests (existing, must stay green): `packages/renderer/src/__tests__/shared-texture-receiver.test.ts`

**Interfaces:**
- Consumes: `toError` from `./to-error`; `FrameReceiveError`, `TextureImportError`, `TextureDeliveryError`, `UnsupportedPixelFormatError`, `ReceiverStoppedError`, `SendPipelineError` from `./errors`; `Result`, `ResultAsync`, `ok`, `err`, `okAsync`, `errAsync` from `neverthrow`.
- Produces: no signature changes. `_send` still resolves to `SendResult`; the bridge still emits plain-`Error`-compatible objects.

- [ ] **Step 1: Baseline** — `pnpm -C packages/renderer test` → all pass.

- [ ] **Step 2: Imports**

```typescript
import { Result, ResultAsync, ok, err, okAsync, errAsync } from "neverthrow";
import {
  FrameReceiveError,
  ReceiverStoppedError,
  TextureDeliveryError,
  TextureImportError,
  UnsupportedPixelFormatError,
} from "./errors";
import type { SendPipelineError } from "./errors";
```

- [ ] **Step 3: Circuit breaker uses ReceiverStoppedError**

In `_countTickError()`, replace

```typescript
      this.emit(
        "error",
        new Error(
          `shared texture receiver stopped after ${MAX_CONSECUTIVE_TICK_ERRORS} consecutive errors`,
        ),
      );
```

with

```typescript
      this.emit("error", new ReceiverStoppedError(MAX_CONSECUTIVE_TICK_ERRORS));
```

(Message is produced by the class constructor and is byte-identical — the test asserts `/stopped after 10 consecutive errors/`.)

- [ ] **Step 4: `_receiveFrame` — fromThrowable + match at the edge**

Replace the method body with:

```typescript
  private _receiveFrame(): SharedTextureFrame | null {
    return Result.fromThrowable(
      () => this.receiver.receiveSharedTexture(),
      (cause) => new FrameReceiveError(toError(cause).message, { cause }),
    )().match(
      (frame) => frame,
      (error) => {
        this._recordTickError(error);
        return null;
      },
    );
  }
```

(Keep the existing doc comment.)

- [ ] **Step 5: Rebuild `_send` as one chain, `.match` once**

Replace `_send` and `_importFrame` entirely with:

```typescript
  private async _send(frame: SharedTextureFrame): Promise<SendResult> {
    if (this.target.isDestroyed()) {
      // Target is gone — handle was minted but Electron will never consume it.
      releaseUnconsumedHandle(frame.handle);
      return "skipped";
    }

    return this._prepare(frame)
      .asyncAndThen((imported) => this._deliver(imported))
      .match(
        (result) => result,
        (error) => {
          this.emit("error", error);
          return "failed";
        },
      );
  }

  /**
   * Validate the frame's pixel format and import it into Electron. On any
   * failure the unconsumed native handle is released here (importSharedTexture
   * never took ownership — without this we leak a per-frame NT HANDLE /
   * IOSurface) and the typed error propagates to `_send`'s single `.match`.
   */
  private _prepare(
    frame: SharedTextureFrame,
  ): Result<Electron.SharedTextureImported, SendPipelineError> {
    return this._validate(frame)
      .andThen((textureInfo) =>
        Result.fromThrowable(
          () => sharedTexture.importSharedTexture({ textureInfo }),
          (cause) => new TextureImportError(toError(cause).message, { cause }),
        )(),
      )
      .orElse((error) => {
        releaseUnconsumedHandle(frame.handle);
        return err(error);
      });
  }

  /** Reject unknown pixel formats; wrap the raw handle for Electron. */
  private _validate(
    frame: SharedTextureFrame,
  ): Result<Electron.SharedTextureImportTextureInfo, UnsupportedPixelFormatError> {
    if (!isValidPixelFormat(frame.pixelFormat)) {
      return err(new UnsupportedPixelFormatError(frame.pixelFormat, VALID_PIXEL_FORMATS));
    }
    const handle =
      process.platform === "win32" ? { ntHandle: frame.handle } : { ioSurface: frame.handle };
    return ok({
      codedSize: { width: frame.width, height: frame.height },
      handle,
      pixelFormat: frame.pixelFormat,
    });
  }

  /**
   * Deliver one imported texture to the target renderer. Releases `imported`
   * on every path (the `finally` inside `send`). Disposal mid-send maps the
   * rejection to `"skipped"` instead of an error, as before.
   */
  private _deliver(
    imported: Electron.SharedTextureImported,
  ): ResultAsync<SendResult, TextureDeliveryError> {
    const targetFrame = this.target.mainFrame;
    if (!targetFrame) {
      imported.release();
      return okAsync("skipped");
    }
    const send = async (): Promise<void> => {
      try {
        await sharedTexture.sendSharedTexture(
          { frame: targetFrame, importedSharedTexture: imported },
          ...this.extraArgs,
        );
      } finally {
        imported.release();
      }
    };
    return ResultAsync.fromPromise(
      send(),
      (cause) => new TextureDeliveryError(toError(cause).message, { cause }),
    )
      .map((): SendResult => "delivered")
      .orElse((error) =>
        this._disposed
          ? okAsync<SendResult, TextureDeliveryError>("skipped")
          : errAsync<SendResult, TextureDeliveryError>(error),
      );
  }
```

Notes:
- If tsgo rejects an `okAsync`/`errAsync` generic inference, add explicit type arguments (as shown) — never an `as` cast.
- Behavioral delta accepted by this plan: on validate/import failure the handle release now happens **before** the error emit (was after for the validate case). Tests assert both occur, not their order — if any test does assert order, STOP and report instead of reordering the chain.

- [ ] **Step 6: Verify** — `pnpm exec oxfmt --write packages/renderer/src/shared-texture-receiver.ts && pnpm lint && pnpm typecheck && pnpm -C packages/renderer test` → all green.

- [ ] **Step 7: Commit**

```bash
git add packages/renderer/src/shared-texture-receiver.ts
git commit -m "refactor(renderer): neverthrow send pipeline with typed error classes"
```

---

### Task B: discovery.ts + preview-manager.ts — neverthrow at the small edges

**Files:**
- Modify: `packages/renderer/src/discovery.ts`
- Modify: `packages/renderer/src/preview-manager.ts`

**Interfaces:**
- Consumes: `toError` from `./to-error`; `Result`, `ResultAsync` from `neverthrow`.
- Produces: no signature changes.

- [ ] **Step 1: Baseline** — `pnpm -C packages/renderer test` → all pass.

- [ ] **Step 2: discovery.ts**

Add `import { Result } from "neverthrow";`. Replace `_refresh` with:

```typescript
  private _refresh(): void {
    if (this._disposed) return;

    Result.fromThrowable(listSenders, toError)().match(
      (current) => this._applyUpdate(current),
      (error) => {
        this.emit("error", error);
      },
    );
  }

  /** Diff `current` against the previous snapshot and emit added/removed/updated. */
  private _applyUpdate(current: SenderInfo[]): void {
    const prev = this._senders;
    const added = current.filter((c) => !prev.some((p) => this._isSame(c, p)));
    const removed = prev.filter((p) => !current.some((c) => this._isSame(c, p)));

    this._senders = current;

    if (added.length > 0) {
      this.emit("added", added);
    }
    if (removed.length > 0) {
      this.emit("removed", removed);
    }
    if (added.length > 0 || removed.length > 0) {
      this.emit("updated", current);
    }
  }
```

(Pass-through `toError` keeps the emitted message identical — `discovery.test.ts` asserts `"Native error"`.)

- [ ] **Step 3: preview-manager.ts — import→send as one chain**

Add `import { Result, ResultAsync } from "neverthrow";` and `import { toError } from "./to-error";`. Replace `sendFrame` with:

```typescript
  sendFrame(texture: { textureInfo: TextureInfo }): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.ready) return;

    // Preview delivery is best-effort by design: both failure channels are
    // intentionally discarded at this edge (the main bridge already reports
    // real pipeline errors).
    void Result.fromThrowable(
      () => sharedTexture.importSharedTexture({ textureInfo: texture.textureInfo }),
      toError,
    )()
      .asyncAndThen((imported) =>
        ResultAsync.fromPromise(
          sharedTexture.sendSharedTexture({
            frame: win.webContents.mainFrame,
            importedSharedTexture: imported,
          }),
          toError,
        ),
      )
      .match(
        () => undefined,
        () => undefined,
      );
  }
```

(The old `if (!imported) return;` guard disappears — `importSharedTexture`'s type never returns undefined, and a throw is now the error channel.)

- [ ] **Step 4: Verify** — `pnpm exec oxfmt --write packages/renderer/src/discovery.ts packages/renderer/src/preview-manager.ts && pnpm lint && pnpm typecheck && pnpm -C packages/renderer test` → all green.

- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/discovery.ts packages/renderer/src/preview-manager.ts
git commit -m "refactor(renderer): neverthrow chains in discovery refresh and preview send"
```

**Deliberately NOT converted (document, don't change):** `bridge.ts handlePaint` and `TextureBridgeImpl.resize` keep native `try/catch` — each is a single throwing step already sitting at its consumption edge (event emit / public throwing API with rollback); a one-step `fromThrowable().match()` adds indirection without a chain. `client/shared-texture-consumer.ts` keeps its `try/finally` — the `finally`-ordered `videoFrame.close()`/`release()` sequencing is load-bearing (macrotask-deferred release) and clearer imperative.

---

### Task C: core — switch-pattern for platform dispatch

**Files:**
- Modify: `packages/core/src/index.ts`

**Interfaces:** no signature changes.

- [ ] **Step 1: Baseline** — `pnpm -C packages/core test` → 9 passed.

- [ ] **Step 2: Convert the platform if-chain to switch (Pattern D, no default = no-op on other platforms)**

Replace the body of `sendTextureFromPaintEvent` from the two platform `if` blocks to:

```typescript
  switch (process.platform) {
    case "win32": {
      const ntHandle = handle.ntHandle;
      if (!ntHandle || !Buffer.isBuffer(ntHandle)) return;
      const handleValue = parseInt(`${ntHandle.readBigInt64LE(0)}`, 10);
      sender.send(handleValue, codedSize.width, codedSize.height);
      return;
    }
    case "darwin": {
      const ioSurface = handle.ioSurface;
      if (!ioSurface) return;
      sender.sendSurface(ioSurface, codedSize.width, codedSize.height);
      return;
    }
  }
```

(No `never` default: `process.platform` is `NodeJS.Platform`, an external union we intentionally no-op for; the never-default rule applies to OUR modeled unions only.)

- [ ] **Step 3: Verify** — `pnpm exec oxfmt --write packages/core/src/index.ts && pnpm lint && pnpm typecheck && pnpm -C packages/core test` → 9 passed.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "refactor(core): switch-based platform dispatch in sendTextureFromPaintEvent"
```

---

### Task D: example package — coding-rules compliance

**Files:**
- Modify: `packages/example/src/renderer/render-worker.ts`
- Modify: `packages/example/src/main/index.ts`
- Modify: `packages/example/src/preload/receiver.ts`

**Interfaces:** none consumed/produced across tasks. No test suite — verify with `pnpm lint && pnpm typecheck` and keep runtime logic identical.

- [ ] **Step 1: render-worker.ts — full rewrite of state + dispatch**

Keep the file-top doc comment, imports, and `declare const self` line. Replace everything from the `// Worker State` banner down with:

```typescript
// ============================================================================
// Worker State
// ============================================================================

/** Everything `init()` creates — present together or not at all. */
interface RenderContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  material: THREE.ShaderMaterial;
}

/** Module-level mutable state; property writes only (repo bans `let`). */
const worker = {
  context: null as RenderContext | null,
  startTime: 0,
  canvasSize: { width: 1920, height: 1080 },
};

const audioData = {
  bass: 0,
  mid: 0,
  high: 0,
  beat: 0,
};

// ============================================================================
// Rendering
// ============================================================================

const lerp = (a: number, b: number, t: number): number => {
  return a + (b - a) * t;
};

const animate = (): void => {
  requestAnimationFrame(animate);

  const context = worker.context;
  if (!context) return;

  const elapsed = (performance.now() - worker.startTime) / 1000;
  context.material.uniforms.u_time.value = elapsed;
  context.material.uniforms.u_bass.value = audioData.bass;
  context.material.uniforms.u_mid.value = audioData.mid;
  context.material.uniforms.u_high.value = audioData.high;
  context.material.uniforms.u_beat.value = audioData.beat;

  audioData.beat *= 0.92;

  context.renderer.render(context.scene, context.camera);
};

const resize = (width: number, height: number): void => {
  const context = worker.context;
  if (!context) return;

  worker.canvasSize = { width, height };
  context.renderer.setSize(width, height, false);
  context.material.uniforms.u_resolution.value.set(width, height);

  console.log(`[render-worker] Resized to ${width}x${height}`);
};

const init = (canvas: OffscreenCanvas): void => {
  worker.canvasSize = { width: canvas.width, height: canvas.height };
  worker.startTime = performance.now();

  const renderer = new THREE.WebGLRenderer({
    canvas: canvas as unknown as HTMLCanvasElement,
    antialias: true,
    // alpha:true + clearAlpha:0 lets the fragment shader's gl_FragColor.a
    // flow through to the framebuffer, which the createTextureBridge
    // `includeAlpha` option then forwards into the Syphon/Spout BGRA texture.
    alpha: true,
    premultipliedAlpha: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });

  // updateStyle: false is required for OffscreenCanvas (no style property)
  renderer.setSize(worker.canvasSize.width, worker.canvasSize.height, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      u_time: { value: 0.0 },
      u_resolution: {
        value: new THREE.Vector2(worker.canvasSize.width, worker.canvasSize.height),
      },
      u_bass: { value: 0.0 },
      u_mid: { value: 0.0 },
      u_high: { value: 0.0 },
      u_beat: { value: 0.0 },
    },
    depthTest: false,
    depthWrite: false,
  });

  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  worker.context = { renderer, scene, camera, material };

  animate();

  console.log("[render-worker] Three.js initialized with raymarching shader");
};

// ============================================================================
// Message Handler
// ============================================================================

type WorkerEvent =
  | { type: "init"; canvas: OffscreenCanvas }
  | { type: "resize"; width: number; height: number }
  | { type: "audio"; bass?: number; mid?: number; high?: number }
  | { type: "beat" };

self.onmessage = (e: MessageEvent<WorkerEvent>) => {
  const msg = e.data;

  switch (msg.type) {
    case "init":
      init(msg.canvas);
      break;

    case "resize":
      resize(msg.width, msg.height);
      break;

    case "audio":
      audioData.bass = lerp(audioData.bass, msg.bass ?? audioData.bass, 0.3);
      audioData.mid = lerp(audioData.mid, msg.mid ?? audioData.mid, 0.3);
      audioData.high = lerp(audioData.high, msg.high ?? audioData.high, 0.3);
      break;

    case "beat":
      audioData.beat = 1.0;
      break;

    default: {
      const _exhaustive: never = msg;
      throw new Error(`unhandled worker message: ${JSON.stringify(_exhaustive)}`);
    }
  }
};
```

(The `canvas as unknown as HTMLCanvasElement` cast stays — it papers over a known Three.js typing gap for OffscreenCanvas, is pre-existing, and there is no model fix available.)

- [ ] **Step 2: main/index.ts — drop `let activeReceiver`, arrow functions, named bootstrap**

(a) `function getRendererUrl(): string {` → `const getRendererUrl = (): string => {` (closing `}` → `};`).

(b) Replace `app.whenReady().then(async () => {` with a named bootstrap: define `const bootstrap = async (): Promise<void> => {` containing the existing body, closing as `};`, and call it at the bottom with `void app.whenReady().then(bootstrap);`.

(c) Inside bootstrap, replace

```typescript
  type SharedTextureReceiver = ReturnType<typeof createSharedTextureReceiver>;
  let activeReceiver: SharedTextureReceiver | null = null;

  const stopActiveReceiver = () => {
    if (activeReceiver) {
      activeReceiver.dispose();
      activeReceiver = null;
    }
  };
```

with

```typescript
  type SharedTextureReceiver = ReturnType<typeof createSharedTextureReceiver>;
  /** Single mutable slot for the currently connected receiver (repo bans `let`). */
  const receiverSlot = { active: null as SharedTextureReceiver | null };

  const stopActiveReceiver = (): void => {
    if (!receiverSlot.active) return;
    receiverSlot.active.dispose();
    receiverSlot.active = null;
  };
```

and update every remaining `activeReceiver` reference to `receiverSlot.active` (the `connect-receiver` assignment, the `set-flip-y` guard + call, the `disconnect-receiver` guard). In `connect-receiver`, assign to a local first so the `.on(...)`/`.start()` wiring reads cleanly:

```typescript
  ipcMain.handle("connect-receiver", (_event, senderName: string, flipY: boolean) => {
    stopActiveReceiver();
    console.log(`[receiver-test] connecting to "${senderName}" (zero-copy, flipY=${flipY})`);

    const receiver = createSharedTextureReceiver({
      senderName,
      target: receiverWindow.webContents,
      pollIntervalMs: 8,
      flipY,
    });
    receiver.on("fps", (fps) => {
      if (!receiverWindow.isDestroyed()) {
        receiverWindow.webContents.send("receiver-fps", fps);
      }
    });
    receiver.on("error", (err) => {
      console.error("[receiver-test] bridge error:", err.message);
    });
    receiver.start();
    receiverSlot.active = receiver;
  });
```

- [ ] **Step 3: preload/receiver.ts — drop `let ui`, drop DOM `as` casts**

(a) Replace `let ui: ReceiverUI | null = null;` with

```typescript
/** Mutable slot filled on DOMContentLoaded (repo bans `let`). */
const uiSlot = { current: null as ReceiverUI | null };
```

and update every `ui` reference: `formatInfo` and the `consumeSharedTexture` `onFrame` and `refreshSenders` start with `const ui = uiSlot.current; if (!ui) return;`, then use the local `ui` unchanged. The DOMContentLoaded handler assigns `uiSlot.current = { ... }`.

(b) Replace the eight `document.getElementById(...) as X | null` casts with an instance-checking helper (arrow, above the DOMContentLoaded listener):

```typescript
const getElement = <T extends HTMLElement>(id: string, ctor: new () => T): T | null => {
  const element = document.getElementById(id);
  return element instanceof ctor ? element : null;
};
```

```typescript
  const canvas = getElement("canvas", HTMLCanvasElement);
  const ctx = canvas?.getContext("2d");
  const info = getElement("info", HTMLDivElement);
  const senderList = getElement("senderList", HTMLSelectElement);
  const refreshBtn = getElement("refreshBtn", HTMLButtonElement);
  const connectBtn = getElement("connectBtn", HTMLButtonElement);
  const disconnectBtn = getElement("disconnectBtn", HTMLButtonElement);
  const flipYCheckbox = getElement("flipYCheckbox", HTMLInputElement);
```

(the existing combined `if (!canvas || !ctx || ...)` guard stays as-is).

(c) In the `connectBtn` click handler, replace `` info.textContent = `Error: ${(err as Error).message}`; `` with

```typescript
      info.textContent = `Error: ${err instanceof Error ? err.message : `${err}`}`;
```

- [ ] **Step 4: Verify** — `pnpm exec oxfmt --write packages/example/src/renderer/render-worker.ts packages/example/src/main/index.ts packages/example/src/preload/receiver.ts && pnpm lint && pnpm typecheck` → green. (No vitest suite for example.)

- [ ] **Step 5: Commit**

```bash
git add packages/example/src/renderer/render-worker.ts packages/example/src/main/index.ts packages/example/src/preload/receiver.ts
git commit -m "refactor(example): remove let globals, arrow functions, exhaustive worker switch"
```

---

## Explicitly evaluated, not applied

- **prefix-match-processor**: largest prefix chain is 3 one-line branches (`bridge.ts` URL scheme) — below the >5-family threshold; keep inline.
- **Public Result API**: user decided internal-only adoption (2026-07-15); revisit only with a major release.
- **neverthrow in `packages/core`**: `sendTextureFromPaintEvent` has no catch/chain today (bridge catches at its edge); adding the dependency there buys nothing.

## Integration (orchestrator)

Merge task branches into `refactor/coding-rules-compliance`, then: `pnpm build:core && pnpm build:renderer && pnpm lint && pnpm typecheck && pnpm -C packages/core test && pnpm -C packages/renderer test`. Expect 9 + (130 + prep error tests) passed. Then request user review via difit.
