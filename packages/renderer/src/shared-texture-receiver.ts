/**
 * Shared-texture (zero-copy GPU) receiver bridge.
 *
 * Receives frames from the native addon — pushed via `onSharedTexture()`
 * (`mode: "push"`) or polled via `receiveSharedTexture()` (`mode: "poll"`) —
 * and fans each one out to every registered target renderer via Electron's
 * `sharedTexture.importSharedTexture` + `sendSharedTexture` pair (available
 * in Electron 40+). A frame is imported once, however many targets receive
 * it.
 *
 * Main process only.
 */

import { EventEmitter } from "events";
import { sharedTexture } from "electron";
import type { WebContents } from "electron";
import { TextureReceiver, closeNativeHandle } from "@napolab/texture-bridge-core";
import type { SharedTextureFrame } from "@napolab/texture-bridge-core";
import type { ForwardDefect } from "@napolab/texture-bridge-core/electron";
import { Result, ResultAsync, ok, err, okAsync, errAsync } from "neverthrow";
import {
  FrameReceiveError,
  ReceiverStoppedError,
  TextureDeliveryError,
  TextureImportError,
  UnsupportedPixelFormatError,
} from "./errors";
import { FpsCounter } from "./fps-counter";
import { notifyForwardObserver, toForwardStatus, unhookDestroyedListener } from "./forward-status";
import { toError } from "./to-error";
import type { ForwardStatus, FrameForward, FrameForwardOptions } from "./types";

/**
 * Safely release the caller's reference on a native shared-texture handle
 * minted by the native receiver (`receiveSharedTexture` / `onSharedTexture`).
 *
 * Every such handle must be released exactly once, whether or not it was
 * imported: Electron's `importSharedTexture` never takes ownership — it
 * `DuplicateHandle`s the NT handle (Windows) or retains the IOSurface (macOS)
 * into its own reference — so releasing right after the import call returns
 * is safe. Any throw here would break the bridge poll loop, so we log and
 * swallow.
 */
const releaseNativeHandle = (handle: Buffer): void => {
  try {
    closeNativeHandle(handle);
  } catch (releaseErr) {
    console.error("[shared-texture] closeNativeHandle threw:", releaseErr);
  }
};

/**
 * Pixel formats the native receiver ever emits and that Electron's
 * `sharedTexture.importSharedTexture` accepts. Kept in lockstep with
 * `dxgi_format_to_pixel_format` (Windows) and `SharedIoSurfaceInfo::
 * pixel_format_string` (macOS). Anything outside this set is rejected before
 * reaching the Electron API to avoid smuggling invalid strings through an
 * `as` cast.
 */
type SharedTexturePixelFormat = "bgra" | "rgba" | "rgbaf16";

const VALID_PIXEL_FORMATS: readonly SharedTexturePixelFormat[] = ["bgra", "rgba", "rgbaf16"];

const isValidPixelFormat = (value: string): value is SharedTexturePixelFormat => {
  return VALID_PIXEL_FORMATS.some((format) => format === value);
};

/**
 * After this many consecutive `_tick` errors, the receiver gives up and stops
 * itself. Prevents flooding the error channel at 60Hz when the native side is
 * permanently broken.
 */
const MAX_CONSECUTIVE_TICK_ERRORS = 10;

/**
 * Throwable native/Electron calls, each bound once to a named
 * `Result.fromThrowable` wrapper (arguments are forwarded — no per-call
 * wrapping, no IIFE-style immediate invocation).
 */
const safeReceiveSharedTexture = Result.fromThrowable(
  (receiver: InstanceType<typeof TextureReceiver>) => receiver.receiveSharedTexture(),
  (cause) => new FrameReceiveError(toError(cause).message, { cause }),
);

const safeSubscribeSharedTexture = Result.fromThrowable(
  (receiver: InstanceType<typeof TextureReceiver>, callback: (frame: SharedTextureFrame) => void) =>
    receiver.onSharedTexture(callback),
  (cause) => new FrameReceiveError(toError(cause).message, { cause }),
);

/**
 * Drop the native push subscription. Must always run on stop/dispose — while
 * subscribed, the native threadsafe function keeps the event loop alive. A
 * throw here (receiver already stopped) leaves nothing to release, so it is
 * logged and swallowed like `releaseNativeHandle`.
 */
const unsubscribeSharedTexture = (receiver: InstanceType<typeof TextureReceiver>): void => {
  try {
    receiver.onSharedTexture(null);
  } catch (unsubscribeErr) {
    console.error("[shared-texture] onSharedTexture(null) threw:", unsubscribeErr);
  }
};

const safeImportSharedTexture = Result.fromThrowable(
  (textureInfo: Electron.SharedTextureImportTextureInfo) =>
    sharedTexture.importSharedTexture({ textureInfo }),
  (cause) => new TextureImportError(toError(cause).message, { cause }),
);

/**
 * Send one imported texture to one frame WITHOUT releasing it — unlike
 * `sendImportedTexture` from core, which releases in `finally`. Fan-out
 * shares one imported texture across several sends, so the release is owned
 * by {@link SharedImport} instead. `async` so a synchronous throw from
 * `sendSharedTexture` becomes a rejection the caller's `fromPromise` maps.
 */
const sendRetainedTexture = async (
  frame: NonNullable<WebContents["mainFrame"]>,
  imported: Electron.SharedTextureImported,
  extraArgs: readonly unknown[],
): Promise<void> => {
  await sharedTexture.sendSharedTexture({ frame, importedSharedTexture: imported }, ...extraArgs);
};

/**
 * One imported texture shared by every send of one frame, refcounted so the
 * main-process reference (`imported.release()`) is dropped exactly once,
 * after every send and every queued reference for it has settled.
 *
 * Electron 40 refcounts renderer frames per imported texture, but the main
 * reference must outlive every in-flight `sendSharedTexture` — releasing it
 * while a send is still pending frees the texture before the renderer side
 * registers its own reference.
 *
 * Starts with one reference owned by the creator (the fan-out loop), which
 * guarantees the release fires even if no send was dispatched.
 */
class SharedImport {
  private refs = 1;
  private delivered = false;
  readonly imported: Electron.SharedTextureImported;

  constructor(imported: Electron.SharedTextureImported) {
    this.imported = imported;
  }

  retain(): SharedImport {
    this.refs += 1;
    return this;
  }

  release(): void {
    if (this.refs === 0) return;
    this.refs -= 1;
    if (this.refs === 0) this.imported.release();
  }

  /** `true` only for the first successful send of this frame (FPS bookkeeping). */
  markDelivered(): boolean {
    if (this.delivered) return false;
    this.delivered = true;
    return true;
  }
}

/**
 * Per-target delivery state shared by both registration kinds. `inFlight`
 * and `pending` give every target its own latest-wins slot: while its send
 * is in flight, only the newest frame is kept (as a reference to that
 * frame's {@link SharedImport}); a slow target drops its own frames without
 * holding back the others.
 */
interface DeliverySlot {
  readonly target: WebContents;
  readonly extraArgs: readonly unknown[];
  inFlight: boolean;
  pending: SharedImport | null;
}

/**
 * The `target` passed to `createSharedTextureReceiver`. Keeps the legacy
 * contract: send failures surface on `"error"` and count toward the circuit
 * breaker, and a destroyed target is skipped per frame (no `"destroyed"`
 * listener — the legacy option never subscribed to one).
 */
interface PrimarySlot extends DeliverySlot {
  readonly kind: "primary";
}

/**
 * One `forwardFrames` registration. Best-effort like
 * `TextureBridge.forwardFrames`: failures surface only through `onStatus`,
 * deduped by `lastStatus`, and never touch `"error"` or the breaker.
 */
interface ForwardSlot extends DeliverySlot {
  readonly kind: "forward";
  readonly onStatus?: (status: ForwardStatus) => void;
  readonly onDestroyed: () => void;
  /** Last reported state, or `null` before the first frame settles. */
  lastStatus: "ok" | ForwardDefect["reason"] | null;
}

type TargetSlot = PrimarySlot | ForwardSlot;

/** Release a slot's queued frame reference, if any. */
const dropSlotPending = (slot: TargetSlot): void => {
  const pending = slot.pending;
  if (!pending) return;
  slot.pending = null;
  pending.release();
};

/** Queue `shared` as the slot's next frame, superseding (releasing) the older one. */
const replaceSlotPending = (slot: TargetSlot, shared: SharedImport): void => {
  dropSlotPending(slot);
  slot.pending = shared.retain();
};

const isLive = (slot: TargetSlot): boolean => !slot.target.isDestroyed();

const isBusy = (slot: TargetSlot): boolean => slot.inFlight;

const INERT_FORWARD: FrameForward = { dispose: () => {}, active: false };

/**
 * How the bridge obtains frames from the native receiver.
 *
 * - `"push"`: the native side stages each frame on the GPU as soon as the
 *   sender publishes it and calls back on the JS thread — no per-frame
 *   synchronous GPU wait, no poll latency. Delivery is latest-wins per
 *   target: while a target's send is in flight only the newest frame is
 *   kept for it, older ones are released.
 * - `"poll"`: a `setInterval` calls `receiveSharedTexture()` every
 *   `pollIntervalMs`; ticks that land while every target's send is in flight
 *   are dropped.
 */
export type SharedTextureReceiveMode = "push" | "poll";

/** Push where the native addon supports it (Syphon / Spout), poll elsewhere. */
const resolveDefaultMode = (platform: NodeJS.Platform): SharedTextureReceiveMode => {
  switch (platform) {
    case "darwin":
    case "win32":
      return "push";
    default:
      return "poll";
  }
};

export interface SharedTextureReceiverOptions {
  readonly senderName: string;
  readonly appName?: string;
  readonly serverUuid?: string;
  /**
   * Frame acquisition mode. Defaults to `"push"` on macOS and Windows,
   * `"poll"` elsewhere. If subscribing to pushed frames fails at `start()`,
   * the bridge emits the `FrameReceiveError` on `"error"` and falls back to
   * polling.
   */
  readonly mode?: SharedTextureReceiveMode;
  /**
   * Polling interval in ms. Defaults to 16 (~60 fps). Only used in `"poll"`
   * mode (including the push-subscription fallback); ignored while pushing.
   */
  readonly pollIntervalMs?: number;
  /**
   * Primary target WebContents to deliver frames to. The bridge forwards to
   * `target.mainFrame` via `sharedTexture.sendSharedTexture`; its send
   * failures surface on `"error"` and count toward the circuit breaker.
   *
   * Optional: omit it to build a target-less receiver and register every
   * destination with {@link SharedTextureReceiverBridge.forwardFrames}. With
   * no live target, frames are not imported at all.
   */
  readonly target?: WebContents;
  /**
   * Optional extra positional arguments that are forwarded to the renderer
   * process's `setSharedTextureReceiver` callback alongside the imported
   * texture (via Electron's `sendSharedTexture(..., ...args)` varargs).
   * Applies to the primary `target` only.
   */
  readonly extraArgs?: readonly unknown[];
  /**
   * Whether the receive path should apply a vertical flip when staging the
   * frame for `importSharedTexture`. Defaults to `true` on macOS — matches
   * the historical behavior shipped in the macOS receiver, suitable when
   * the consumer expects Y-DOWN image-coord layout (`drawImage(VideoFrame)`,
   * WebGPU `importExternalTexture`).
   *
   * Pass `false` when the upstream Syphon source already publishes the
   * orientation Electron's `importSharedTexture` expects — e.g. if the
   * sender lives in another Electron window that publishes via this same
   * library and does not need an additional flip on receive.
   *
   * No-op on Windows (Spout's receive path does not have a flip stage).
   */
  readonly flipY?: boolean;
}

export interface SharedTextureReceiverBridgeEvents {
  fps: [fps: number];
  error: [error: Error];
  disposed: [];
}

export interface SharedTextureReceiverBridge {
  on<K extends keyof SharedTextureReceiverBridgeEvents>(
    event: K,
    listener: (...args: SharedTextureReceiverBridgeEvents[K]) => void,
  ): this;
  off<K extends keyof SharedTextureReceiverBridgeEvents>(
    event: K,
    listener: (...args: SharedTextureReceiverBridgeEvents[K]) => void,
  ): this;
  once<K extends keyof SharedTextureReceiverBridgeEvents>(
    event: K,
    listener: (...args: SharedTextureReceiverBridgeEvents[K]) => void,
  ): this;

  start(): void;
  stop(): void;
  dispose(): void;
  [Symbol.dispose](): void;
  readonly isDisposed: boolean;
  /**
   * Live-toggle the receive-side Y-flip pass without recreating the
   * receiver. Same semantics as the constructor `flipY` option. No-op on
   * Windows.
   */
  setFlipY(flip: boolean): void;
  /**
   * Register another `WebContents` to receive every frame of this source —
   * one native receive and one import per frame, however many targets
   * there are. Same contract as `TextureBridge.forwardFrames`: best-effort
   * (failures are reported only through {@link FrameForwardOptions.onStatus},
   * never on `"error"`, and never trip the circuit breaker), auto-unregisters
   * when `target` is destroyed, `dispose()` is idempotent.
   *
   * Each target has its own latest-wins slot, so a slow renderer only drops
   * its own frames. Calling this after the receiver has been disposed — or
   * against an already-destroyed `target` — returns an inert
   * {@link FrameForward} (`active: false`, no-op `dispose()`).
   */
  forwardFrames(target: WebContents, options?: FrameForwardOptions): FrameForward;
}

class SharedTextureReceiverBridgeImpl extends EventEmitter implements SharedTextureReceiverBridge {
  private receiver: InstanceType<typeof TextureReceiver>;
  /** Every registered destination: the optional primary and each forward. */
  private readonly slots = new Set<TargetSlot>();
  private fpsCounter = new FpsCounter();
  private _disposed = false;
  private _started = false;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _consecutiveErrors = 0;
  private _subscribed = false;
  /**
   * Push mode: newest native frame that arrived while EVERY live target was
   * busy. Held unimported (nothing could send it yet); the first target to
   * free up imports it for everyone.
   */
  private _pending: SharedTextureFrame | null = null;
  private pollIntervalMs: number;
  private mode: SharedTextureReceiveMode;

  constructor(
    receiver: InstanceType<typeof TextureReceiver>,
    target: WebContents | undefined,
    extraArgs: readonly unknown[],
    pollIntervalMs: number,
    mode: SharedTextureReceiveMode,
  ) {
    super();
    this.receiver = receiver;
    this.pollIntervalMs = pollIntervalMs;
    this.mode = mode;
    if (target) {
      this.slots.add({ kind: "primary", target, extraArgs, inFlight: false, pending: null });
    }
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  start(): void {
    if (this._disposed || this._started) return;
    this._started = true;
    this._consecutiveErrors = 0;
    this.fpsCounter.reset();
    switch (this.mode) {
      case "push":
        this._startPush();
        return;
      case "poll":
        this._startPolling();
        return;
      default: {
        const _exhaustive: never = this.mode;
        throw new Error(`unhandled receive mode: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  stop(): void {
    this._started = false;
    this._stopPolling();
    this._stopPush();
    this._dropPending();
    for (const slot of this.slots) {
      dropSlotPending(slot);
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    // Unhook every forward's "destroyed" listener before clearing — it sits
    // on a caller-owned, possibly long-lived WebContents and would retain
    // this disposed bridge forever.
    for (const slot of this.slots) {
      if (slot.kind === "forward") unhookDestroyedListener(slot);
    }
    this.slots.clear();
    this.receiver.stop();
    this.emit("disposed");
    this.removeAllListeners();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  setFlipY(flip: boolean): void {
    if (this._disposed) return;
    this.receiver.setFlipY(flip);
  }

  forwardFrames(target: WebContents, options?: FrameForwardOptions): FrameForward {
    // Registering after dispose — or against a target whose "destroyed"
    // event already fired — could never self-prune: refuse with an inert
    // handle whose `active: false` makes the refusal visible.
    if (this._disposed || target.isDestroyed()) return INERT_FORWARD;

    // `slot` closes over itself via `onDestroyed` — safe: the closure only
    // runs once `target` fires "destroyed", long after the assignment.
    const slot: ForwardSlot = {
      kind: "forward",
      target,
      extraArgs: options?.extraArgs ?? [],
      onStatus: options?.onStatus,
      onDestroyed: (): void => {
        this._removeSlot(slot);
      },
      lastStatus: null,
      inFlight: false,
      pending: null,
    };
    this.slots.add(slot);
    target.once("destroyed", slot.onDestroyed);

    // Membership is liveness; captured as a local because an object-literal
    // getter does not inherit the enclosing `this`.
    const slots = this.slots;

    return {
      dispose: () => {
        this._removeSlot(slot);
        unhookDestroyedListener(slot);
      },
      get active(): boolean {
        return slots.has(slot);
      },
    };
  }

  /**
   * Unregister one forward: drop its queued frame reference now. An in-flight
   * send still settles and releases its own reference; its outcome is not
   * reported because the slot is no longer registered.
   */
  private _removeSlot(slot: ForwardSlot): void {
    if (!this.slots.delete(slot)) return;
    dropSlotPending(slot);
  }

  private _startPolling(): void {
    this._timer = setInterval(() => {
      void this._tick();
    }, this.pollIntervalMs);
  }

  private _stopPolling(): void {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * Subscribe to native pushed frames — the single consumer of
   * `_subscribePush()`'s `Result`. A subscription failure (e.g. a native
   * build without push support) is surfaced on `"error"` and the bridge
   * falls back to polling so frames keep flowing.
   */
  private _startPush(): void {
    this._subscribePush().match(
      () => {
        this._subscribed = true;
      },
      (error) => {
        // Start the fallback before emitting: an unhandled "error" throws,
        // and the bridge must not be left started-but-dead.
        this._startPolling();
        this.emit("error", error);
      },
    );
  }

  private _subscribePush(): Result<void, FrameReceiveError> {
    return safeSubscribeSharedTexture(this.receiver, (frame) => this._onPushedFrame(frame));
  }

  private _stopPush(): void {
    if (!this._subscribed) return;
    this._subscribed = false;
    unsubscribeSharedTexture(this.receiver);
  }

  /** Release the handle of the held (unimported) native frame, if any. */
  private _dropPending(): void {
    if (!this._pending) return;
    releaseNativeHandle(this._pending.handle);
    this._pending = null;
  }

  /** Live targets — registered and not destroyed. */
  private _liveSlots(): TargetSlot[] {
    return [...this.slots].filter(isLive);
  }

  /**
   * Native push callback (JS thread). Every handle is released exactly once
   * via `releaseNativeHandle` — right after its import attempt (`_prepare`),
   * or unimported when it is superseded, dropped, has no live target, or
   * arrives after stop.
   */
  private _onPushedFrame(frame: SharedTextureFrame): void {
    if (this._disposed || !this._started) {
      releaseNativeHandle(frame.handle);
      return;
    }
    void this._dispatchFrame(frame);
  }

  /**
   * Route one received frame (push and poll share this path). No live
   * target → close the handle without importing. Every live target busy →
   * hold the frame unimported (latest-wins, older held frame closed).
   * Otherwise import once and fan out — the single consumer of `_prepare`'s
   * `Result`.
   *
   * `async` only so an `"error"` emit with no listener becomes a rejected
   * promise instead of a throw into the native callback, as before.
   */
  private async _dispatchFrame(frame: SharedTextureFrame): Promise<void> {
    const live = this._liveSlots();
    if (live.length === 0) {
      releaseNativeHandle(frame.handle);
      return;
    }
    if (live.every(isBusy)) {
      this._dropPending();
      this._pending = frame;
      return;
    }
    this._prepare(frame).match(
      (imported) => this._fanOut(new SharedImport(imported), live),
      (error) => this._recordFrameError(error, live),
    );
  }

  /**
   * Hand one imported frame to every live target: idle targets send it now,
   * busy ones queue a reference to it (superseding their older queued
   * frame). The creator reference is dropped last, so the imported texture
   * is released exactly once, when the final send or queued reference goes.
   */
  private _fanOut(shared: SharedImport, live: readonly TargetSlot[]): void {
    for (const slot of live) {
      if (slot.inFlight) {
        replaceSlotPending(slot, shared);
        continue;
      }
      dropSlotPending(slot);
      void this._deliverTo(slot, shared.retain());
    }
    shared.release();
  }

  /**
   * A frame-level failure (unsupported pixel format, import throw): reported
   * to every live forward's `onStatus` as `import-failed`, then on `"error"`
   * with circuit-breaker accounting as before. Statuses go first because an
   * `"error"` emit with no listener throws.
   */
  private _recordFrameError(
    error: UnsupportedPixelFormatError | TextureImportError,
    live: readonly TargetSlot[],
  ): void {
    for (const slot of live) {
      if (slot.kind === "forward")
        this._settleForward(slot, { reason: "import-failed", cause: error });
    }
    this._recordTickError(error);
  }

  /**
   * Send one frame to one target and consume the outcome. Owns one
   * reference on `shared` for the duration of the send and releases it on
   * every outcome — including after dispose. Then hands the now-idle target
   * its next frame (latest-wins).
   */
  private async _deliverTo(slot: TargetSlot, shared: SharedImport): Promise<void> {
    slot.inFlight = true;
    const sent = await this._send(slot, shared.imported);
    slot.inFlight = false;
    shared.release();

    if (this._disposed) return;

    this._settleSend(slot, shared, sent);
    this._deliverNext(slot);
  }

  /**
   * After a target's send settles: a held native frame is newer than
   * anything queued, so it is imported and fanned out to every idle target;
   * otherwise the target's own queued frame goes next. Nothing is sent once
   * the receiver has been stopped or the slot unregistered.
   */
  private _deliverNext(slot: TargetSlot): void {
    if (this._disposed || !this._started) return;
    const held = this._pending;
    if (held) {
      this._pending = null;
      // The held frame is newer than this slot's queued one; drop it now so
      // it does not outlive a failed import of the held frame.
      dropSlotPending(slot);
      void this._dispatchFrame(held);
      return;
    }
    const next = slot.pending;
    if (!next || !this.slots.has(slot)) return;
    slot.pending = null;
    void this._deliverTo(slot, next);
  }

  /**
   * Consume one send's `Result` — the single place a send outcome becomes
   * FPS / breaker / `"error"` (primary) or `onStatus` (forward) bookkeeping.
   */
  private _settleSend(
    slot: TargetSlot,
    shared: SharedImport,
    sent: Result<SendResult, TextureDeliveryError>,
  ): void {
    sent.match(
      (result) => {
        switch (result) {
          case "delivered":
            this._recordDelivered(shared);
            if (slot.kind === "forward") this._settleForward(slot, undefined);
            return;
          case "skipped":
            // Not a failure (destroyed target / no mainFrame). Neither counts
            // toward nor resets the breaker, and does not tick FPS.
            if (slot.kind === "forward") this._settleForward(slot, { reason: "target-destroyed" });
            return;
          default: {
            const _exhaustive: never = result;
            throw new Error(`unhandled send result: ${JSON.stringify(_exhaustive)}`);
          }
        }
      },
      (error) => {
        switch (slot.kind) {
          case "primary":
            this._recordTickError(error);
            return;
          case "forward":
            this._settleForward(slot, { reason: "send-failed", cause: error });
            return;
          default: {
            const _exhaustive: never = slot;
            throw new Error(`unhandled slot: ${JSON.stringify(_exhaustive)}`);
          }
        }
      },
    );
  }

  /**
   * A send resolved: reset the consecutive-error counter and tick FPS once
   * per frame (the first target to receive it), however many targets there
   * are.
   */
  private _recordDelivered(shared: SharedImport): void {
    this._consecutiveErrors = 0;
    if (!shared.markDelivered()) return;
    const fps = this.fpsCounter.tick();
    if (fps !== null) this.emit("fps", fps);
  }

  /**
   * Record one frame's outcome for a forward and announce it only when it
   * differs from the last announced one (first success, first failure,
   * change of reason, recovery). An outcome for an unregistered forward is
   * dropped — nobody owns it anymore.
   */
  private _settleForward(slot: ForwardSlot, defect: ForwardDefect | undefined): void {
    if (!this.slots.has(slot)) return;
    const next = defect?.reason ?? "ok";
    if (next === slot.lastStatus) return;
    slot.lastStatus = next;
    const status = toForwardStatus(defect);
    notifyForwardObserver(() => slot.onStatus?.(status), "forwardFrames onStatus");
  }

  /**
   * Emit `"error"` and count it toward the circuit breaker. If the consecutive
   * count crosses `MAX_CONSECUTIVE_TICK_ERRORS`, stop the receiver and emit a
   * final shutdown error. Does NOT call `dispose()` — releasing native
   * resources is the caller's responsibility. Counts receive / prepare
   * errors and primary-target send errors; forward failures never land here.
   */
  private _recordTickError(error: Error): void {
    this.emit("error", error);
    this._countTickError();
  }

  /**
   * Bump the consecutive-error counter and, once it crosses the threshold,
   * stop the receiver and emit the circuit-breaker error. Shared bookkeeping
   * behind `_recordTickError`.
   */
  private _countTickError(): void {
    this._consecutiveErrors += 1;
    if (this._consecutiveErrors >= MAX_CONSECUTIVE_TICK_ERRORS) {
      this.stop();
      this.emit("error", new ReceiverStoppedError(MAX_CONSECUTIVE_TICK_ERRORS));
    }
  }

  /**
   * One poll tick — the single consumer of `_receiveFrame()`'s `Result`.
   *
   * Drop-latest: if every live target's send is still in flight, this tick
   * is a no-op (no native receive at all). That keeps imported-texture
   * references bounded and prevents frame pile-up when renderers are slow.
   *
   * Receive errors are consumed synchronously (same-tick circuit-breaker
   * accounting); the frame then goes through the same `_dispatchFrame` path
   * as push mode.
   */
  private async _tick(): Promise<void> {
    if (this._disposed) return;
    const live = this._liveSlots();
    if (live.length > 0 && live.every(isBusy)) return;

    const frame = this._receiveFrame().match(
      (value) => value,
      (error) => {
        this._recordTickError(error);
        return null;
      },
    );
    if (!frame) return;

    await this._dispatchFrame(frame);
  }

  /**
   * Poll the native receiver once. Returns `Ok(frame | null)` on the success
   * channel — `null` means no new frame, not a failure — or the typed
   * `FrameReceiveError` on the `Err` side. A pure producer: consumption
   * happens once, in `_tick`.
   */
  private _receiveFrame(): Result<SharedTextureFrame | null, FrameReceiveError> {
    return safeReceiveSharedTexture(this.receiver);
  }

  /**
   * Validate the frame's pixel format and import it into Electron, then
   * release the native handle on BOTH outcomes. `importSharedTexture` never
   * takes ownership — it holds its own duplicated NT HANDLE / retained
   * IOSurface — so the receiver's reference must be released exactly once
   * after the import attempt, success or failure; skipping it leaks one NT
   * HANDLE / IOSurface retain per frame. `andTee` / `orTee` tap each side and
   * pass it through unchanged; exactly one of them runs.
   */
  private _prepare(
    frame: SharedTextureFrame,
  ): Result<Electron.SharedTextureImported, UnsupportedPixelFormatError | TextureImportError> {
    return this._validate(frame)
      .andThen((textureInfo) => safeImportSharedTexture(textureInfo))
      .andTee(() => releaseNativeHandle(frame.handle))
      .orTee(() => releaseNativeHandle(frame.handle));
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
   * Send one imported texture to one target. Never releases `imported` —
   * the caller's {@link SharedImport} reference owns that. A destroyed
   * target or missing mainFrame is `"skipped"`; disposal mid-send maps the
   * rejection to `"skipped"` instead of an error, as before.
   */
  private _send(
    slot: TargetSlot,
    imported: Electron.SharedTextureImported,
  ): ResultAsync<SendResult, TextureDeliveryError> {
    if (slot.target.isDestroyed()) return okAsync("skipped");
    const targetFrame = slot.target.mainFrame;
    if (!targetFrame) return okAsync("skipped");
    return ResultAsync.fromPromise(
      sendRetainedTexture(targetFrame, imported, slot.extraArgs),
      (cause) => new TextureDeliveryError(toError(cause).message, { cause }),
    )
      .map((): SendResult => "delivered")
      .orElse((error) =>
        this._disposed
          ? okAsync<SendResult, TextureDeliveryError>("skipped")
          : errAsync<SendResult, TextureDeliveryError>(error),
      );
  }
}

/**
 * `Ok` outcome of a single per-target `_send()` call — pipeline failures
 * (invalid pixel format, `importSharedTexture` throw, `sendSharedTexture`
 * rejection) ride the `Err` channel instead.
 *
 * - `"delivered"`: frame reached `sendSharedTexture` and resolved. Resets the
 *   circuit-breaker counter and ticks FPS (once per frame).
 * - `"skipped"`: an expected non-error path (target webContents destroyed, no
 *   mainFrame, disposed mid-send). Neither counts nor resets.
 */
type SendResult = "delivered" | "skipped";

/**
 * Create a shared-texture receiver bridge.
 *
 * The returned bridge receives Spout/Syphon frames — pushed by the native side
 * (`mode: "push"`, default on macOS / Windows) or polled every
 * `pollIntervalMs` (`mode: "poll"`) — and delivers each frame as a GPU-shared
 * texture to `options.target`'s renderer and to every target registered with
 * `forwardFrames()`, importing each frame once. The renderer must register a
 * handler via `bindSharedTextureReceiver(sharedTexture).consume()` from
 * `@napolab/texture-bridge-renderer/client`.
 *
 * @throws {TypeError} `pollIntervalMs` was passed and is not a positive
 * finite number.
 * @throws when the native `TextureReceiver` cannot be constructed — most
 * commonly no sender is publishing under `senderName` yet.
 *
 * Construction is the only throwing step: `start()` / `stop()` /
 * `dispose()` / `setFlipY()` / `forwardFrames()` never throw, and every
 * per-frame failure arrives on `"error"` as `FrameReceiveError`,
 * `TextureImportError`, `TextureDeliveryError` (primary target only),
 * `UnsupportedPixelFormatError`, or `ReceiverStoppedError` (emitted after 10
 * consecutive failures, which stops the poll timer / push subscription
 * without disposing the bridge). In push mode a failed subscription at
 * `start()` is also emitted as `FrameReceiveError`, after which the bridge
 * falls back to polling.
 *
 * @experimental Requires Electron 40+ `sharedTexture` module.
 */
export const createSharedTextureReceiver = (
  options: SharedTextureReceiverOptions,
): SharedTextureReceiverBridge => {
  const {
    senderName,
    appName,
    serverUuid,
    pollIntervalMs = 16,
    mode = resolveDefaultMode(process.platform),
    target,
    extraArgs = [],
    flipY,
  } = options;

  if (options.pollIntervalMs !== undefined) {
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new TypeError("pollIntervalMs must be a positive finite number");
    }
  }

  const receiver = new TextureReceiver(senderName, appName, serverUuid);
  if (flipY !== undefined) {
    receiver.setFlipY(flipY);
  }
  return new SharedTextureReceiverBridgeImpl(receiver, target, extraArgs, pollIntervalMs, mode);
};
