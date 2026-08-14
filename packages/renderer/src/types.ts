import type { BrowserWindow, WebContents } from "electron";
import type { PaintDefect } from "@napolab/texture-bridge-core";
import type { ForwardDefect } from "@napolab/texture-bridge-core/electron";

/** Options for the preview window */
export interface PreviewOptions {
  enabled?: boolean;
  width?: number;
  height?: number;
  title?: string;
}

/** Options for createTextureBridge() */
export interface TextureBridgeOptions {
  /** Syphon/Spout sender name visible to VJ software */
  name: string;
  /** Texture width in pixels */
  width: number;
  /** Texture height in pixels */
  height: number;
  /** Target frame rate (default: 60) */
  frameRate?: number;
  /** URL to load in the offscreen renderer (file:// or http://) */
  rendererUrl: string;
  /** Preview window options */
  preview?: PreviewOptions;
  /** Additional webPreferences for the offscreen BrowserWindow */
  webPreferences?: Electron.WebPreferences;
  /**
   * Include the page's alpha channel in the captured texture (default: false).
   *
   * When true, the offscreen BrowserWindow is created with `transparent: true`
   * and a fully-transparent backgroundColor so Chromium's compositor preserves
   * per-pixel alpha into the BGRA shared texture. The page (or its body / root
   * elements) must use a transparent background — opaque CSS will overwrite
   * the alpha and produce a fully-opaque output regardless of this flag.
   *
   * VJ software (Resolume, VDMX, etc.) consumes the alpha channel as the
   * layer's transparency mask, enabling overlay / lower-third compositing.
   */
  includeAlpha?: boolean;
  /**
   * Pin the offscreen framebuffer to exactly `width × height` pixels regardless
   * of the host display's device pixel ratio (default: false).
   *
   * Electron ≥ 41: this option is trivially satisfied and effectively a no-op —
   * the bridge pins `webPreferences.offscreen.deviceScaleFactor` to 1, so the
   * framebuffer always lands at exactly `width × height` pixels regardless of
   * display scaling (Electron 42 changed the OSR default device scale factor
   * to 1.0; the bridge makes it explicit from 41 where the option first
   * exists). The DIP-division described below applies only to Electron 40.
   *
   * Chromium's offscreen render surface is normally sized as `width × height`
   * in DIP (device-independent pixels), so the framebuffer actually delivered
   * to the GPU shared-texture path is `DIP × display.scaleFactor`. On a
   * Windows host running at 150% / 175% display scaling, or on a macOS
   * Retina display, this means a sender declared with `width: 1920` ends up
   * producing a 2880-pixel-wide (or 3360, etc.) texture — and on Windows the
   * window can additionally be clamped to the display work area, producing
   * non-uniform scaling on both axes.
   *
   * When set to `true`:
   * - The BrowserWindow's DIP size is computed as
   *   `Math.round(width / scaleFactor) × Math.round(height / scaleFactor)`
   *   so the resulting framebuffer matches the requested pixel dimensions
   *   on the primary display.
   * - `enableLargerThanScreen: true` is applied so the window is not
   *   clamped to the display work area on macOS (Windows allows it by
   *   default, but the flag is harmless on other platforms).
   * - The Spout / Syphon sender is registered at the requested `width × height`
   *   pixel size — receivers always see the requested dimensions.
   *
   * Limitations:
   * - Computed DIP is rounded to integers. Non-divisible scaleFactor ratios
   *   (e.g., 1920 / 1.75 = 1097.14...) can produce a 1-pixel discrepancy
   *   between the sender's declared size and the actual framebuffer.
   * - Only the primary display's scaleFactor at construction time is honored.
   *   If the system DPI changes mid-session, callers must `resize()` (which
   *   re-applies the math) for the framebuffer to track the new scale.
   */
  pixelExact?: boolean;
}

/** Events emitted by TextureBridge */
export interface BridgeEvents {
  fps: [fps: number];
  ready: [];
  error: [error: Error];
  /**
   * A paint frame was dropped before reaching the sender (missing texture /
   * missing platform handle / unsupported platform). Not an error — but if
   * this fires persistently the output is black on the receiving side.
   * Consecutive drops with the same reason are deduped: the event fires on
   * the first occurrence and again only after a successful send or a reason
   * change. A thrown native send failure (surfaced via the "error" event)
   * neither emits frameDropped nor resets the dedupe state — droppedReason
   * keeps the last drop reason until a successful send or a reason change.
   */
  frameDropped: [defect: PaintDefect];
  /**
   * The delivery state of one `forwardFrames` registration changed. Fires on
   * the first successful frame, on the first failure, on a change of failure
   * reason, and once again on recovery — never per frame. Which registration
   * it refers to is identified by `extraArgs` (the tag passed to
   * {@link TextureBridge.forwardFrames}).
   *
   * Forwarding is best-effort and never surfaces as an `"error"` event: this
   * is the only channel that reports it. Without it a monitor window can go
   * black indefinitely while paint, sender and preview all stay healthy.
   */
  forwardStatus: [status: ForwardStatusEvent];
  disposed: [];
  resize: [width: number, height: number];
}

/**
 * 転送先 1 つ分の配信状態。失敗の立ち上がりと復帰を 1 本のチャネルで表す
 * 判別可能ユニオン — 「今どちらなのか」を分岐で必ず読ませるための形。
 */
export type ForwardStatus =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: ForwardDefect["reason"];
      /** `target-destroyed` には原因例外が無いので省略される */
      readonly cause?: Error;
    };

/**
 * `forwardStatus` イベントの payload。どの登録の話かは `extraArgs`
 * (= {@link FrameForwardOptions.extraArgs}) で識別する。
 */
export type ForwardStatusEvent = ForwardStatus & { readonly extraArgs: readonly unknown[] };

/** Options for {@link TextureBridge.forwardFrames} */
export interface FrameForwardOptions {
  /** consumeSharedTexture の handler に varargs で届くタグ(例: slot 番号) */
  readonly extraArgs?: readonly unknown[];
  /**
   * この登録の配信状態が変わったときだけ呼ばれる。`forwardStatus` イベントと
   * 同じ遷移を、対象を絞った形で受け取るための口 — 転送先ごとに別々の宛先へ
   * ログを出す呼び出し側は、こちらの方が相関付けが要らない。
   *
   * best-effort な監視チャネルなので、ここで throw しても転送は止まらない
   * (例外は握られ、`console.error` に落ちる)。
   */
  readonly onStatus?: (status: ForwardStatus) => void;
}

/** Handle returned by {@link TextureBridge.forwardFrames} */
export interface FrameForward {
  /** 転送登録を解除する。冪等 */
  dispose(): void;
  /**
   * 登録が生きているか。`false` ならこの handle にフレームは流れない —
   * 登録自体が拒否された(bridge が dispose 済み / target が破壊済み)場合と、
   * `dispose()` 済み、target が後から破壊された場合を区別せずに表す。
   *
   * 登録の拒否は 0.14 まで無言だった。呼び出し側は登録直後にこれを見ることで
   * 「配線したつもりで 1 枚も流れない」状態を即座に検出できる。
   */
  readonly active: boolean;
}

/** High-level texture bridge handle */
export interface TextureBridge {
  on<K extends keyof BridgeEvents>(event: K, listener: (...args: BridgeEvents[K]) => void): this;
  off<K extends keyof BridgeEvents>(event: K, listener: (...args: BridgeEvents[K]) => void): this;
  once<K extends keyof BridgeEvents>(event: K, listener: (...args: BridgeEvents[K]) => void): this;

  /**
   * Open the preview window (no-op if already open, and after dispose).
   *
   * @throws whatever `new BrowserWindow` throws — this is one of the two
   * `TextureBridge` methods with a failure path; the rest are no-op-or-emit.
   */
  openPreview(): void;
  /** Close the preview window (no-op if already closed). Never throws. */
  closePreview(): void;

  /**
   * Resize all layers: offscreen window, sender, preview, and worker.
   * No-op after dispose.
   *
   * @throws when the replacement native `TextureSender` cannot be
   * constructed (name collision, device failure). The requested size is
   * rolled back and the previous sender rebuilt before the throw escapes,
   * so the bridge stays usable.
   */
  resize(width: number, height: number): void;

  /**
   * Register a `WebContents` (e.g. a monitor/multiviewer window) to receive
   * every subsequent paint frame via zero-copy shared-texture forwarding.
   * Same best-effort contract as the preview path: forward failures
   * (`ForwardDefect`, from `forwardSharedTexture`) never surface as an
   * `"error"` event and never stop the stream — they are reported as state
   * transitions through the `forwardStatus` event and
   * {@link FrameForwardOptions.onStatus} — the receiving end is
   * `installSharedTextureReceiver` / `consumeSharedTexture` on
   * `@napolab/texture-bridge-renderer/client`. Call `dispose()` on the
   * returned {@link FrameForward} to stop forwarding to that target
   * (idempotent).
   *
   * The current implementation imports the texture once per target per
   * frame. When multiple targets share the same source frame, there is
   * room to optimize to "import once per frame → send to every target →
   * release only after all sends settle" — deferred as YAGNI until a
   * multi-target workload actually needs it.
   *
   * Calling this after the bridge has been disposed — or against an
   * already-destroyed `target` — returns an inert {@link FrameForward} whose
   * `dispose()` is a no-op and whose `active` is `false`; it does not
   * register. Check `active` at the call site to catch a refused wiring.
   */
  forwardFrames(target: WebContents, options?: FrameForwardOptions): FrameForward;

  /** The offscreen BrowserWindow used for rendering */
  readonly renderWindow: BrowserWindow;
  /** The preview BrowserWindow, if open */
  readonly previewWindow: BrowserWindow | null;

  /** Whether the bridge has been disposed */
  readonly isDisposed: boolean;

  /**
   * Reason of the most recently dropped frame, or `null` after a successful
   * send (or before the first paint). Lets callers observe a drop that
   * latched before their `frameDropped` listener was attached (e.g. while
   * the renderer page was still loading).
   */
  readonly droppedReason: PaintDefect["reason"] | null;

  /**
   * Tear down all resources. The offscreen window is `destroy()`ed
   * synchronously (not `close()`d) so teardown cannot lose the race against
   * `before-quit` — no separate `renderWindow.destroy()` workaround is
   * needed. The preview window (a visible window with real close semantics)
   * still closes normally via `close()`. Terminal operation — the bridge
   * cannot be reused afterward.
   */
  dispose(): void;

  /** Alias for dispose(), enabling `using bridge = await createTextureBridge(...)` */
  [Symbol.dispose](): void;
}
