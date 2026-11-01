/**
 * Shared-texture (zero-copy GPU) receiver bridge.
 *
 * Polls the native addon's `receiveSharedTexture()` and forwards each frame to
 * a target renderer via Electron's `sharedTexture.importSharedTexture` +
 * `sendSharedTexture` pair (available in Electron 40+).
 *
 * Main process only.
 */

import { EventEmitter } from "events";
import { sharedTexture } from "electron";
import type { WebContents } from "electron";
import { TextureReceiver, closeNativeHandle } from "@napolab/texture-bridge-core";
import type { SharedTextureFrame } from "@napolab/texture-bridge-core";
import { sendImportedTexture } from "@napolab/texture-bridge-core/electron";
import { Result, ResultAsync, ok, err, okAsync, errAsync } from "neverthrow";
import {
  FrameReceiveError,
  ReceiverStoppedError,
  TextureDeliveryError,
  TextureImportError,
  UnsupportedPixelFormatError,
} from "./errors";
import { FpsCounter } from "./fps-counter";
import { toError } from "./to-error";

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

const safeImportSharedTexture = Result.fromThrowable(
  (textureInfo: Electron.SharedTextureImportTextureInfo) =>
    sharedTexture.importSharedTexture({ textureInfo }),
  (cause) => new TextureImportError(toError(cause).message, { cause }),
);

export interface SharedTextureReceiverOptions {
  readonly senderName: string;
  readonly appName?: string;
  readonly serverUuid?: string;
  /** Polling interval in ms. Defaults to 16 (~60 fps). */
  readonly pollIntervalMs?: number;
  /**
   * Target WebContents to deliver frames to. The bridge forwards to
   * `target.mainFrame` via `sharedTexture.sendSharedTexture`.
   */
  readonly target: WebContents;
  /**
   * Optional extra positional arguments that are forwarded to the renderer
   * process's `setSharedTextureReceiver` callback alongside the imported
   * texture (via Electron's `sendSharedTexture(..., ...args)` varargs).
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
}

class SharedTextureReceiverBridgeImpl extends EventEmitter implements SharedTextureReceiverBridge {
  private receiver: InstanceType<typeof TextureReceiver>;
  private target: WebContents;
  private extraArgs: readonly unknown[];
  private fpsCounter = new FpsCounter();
  private _disposed = false;
  private _started = false;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _inFlight = false;
  private _consecutiveErrors = 0;
  private pollIntervalMs: number;

  constructor(
    receiver: InstanceType<typeof TextureReceiver>,
    target: WebContents,
    extraArgs: readonly unknown[],
    pollIntervalMs: number,
  ) {
    super();
    this.receiver = receiver;
    this.target = target;
    this.extraArgs = extraArgs;
    this.pollIntervalMs = pollIntervalMs;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  start(): void {
    if (this._disposed || this._started) return;
    this._started = true;
    this._consecutiveErrors = 0;
    this.fpsCounter.reset();
    this._timer = setInterval(() => {
      void this._tick();
    }, this.pollIntervalMs);
  }

  stop(): void {
    this._started = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
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

  /**
   * Emit `"error"` and count it toward the circuit breaker. If the consecutive
   * count crosses `MAX_CONSECUTIVE_TICK_ERRORS`, stop the receiver and emit a
   * final shutdown error. Does NOT call `dispose()` — releasing native
   * resources is the caller's responsibility. Called from `_tick`, the single
   * consumer of both `_receiveFrame()`'s and `_send()`'s `Result` values.
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
   * One poll tick — the single consumer of both `_receiveFrame()`'s and
   * `_send()`'s `Result` values; each `.match()` here is the one place a
   * pipeline value crosses from the `Result` channel into `"error"` emits /
   * circuit-breaker bookkeeping. Producers (`_receiveFrame`, `_send`,
   * `_prepare`, `_deliver`) only ever return `Result`/`ResultAsync` — they
   * never emit or consume themselves.
   *
   * Drop-latest: if a previous send is still in flight (the Electron
   * `sendSharedTexture` Promise has not resolved yet), this tick is a no-op.
   * That keeps at most one imported-texture reference alive on the main
   * process at any time and prevents frame pile-up when the renderer is slow.
   *
   * Receive errors are consumed synchronously (same-tick circuit-breaker
   * accounting — matches the pre-neverthrow behavior); send/prepare/deliver
   * errors are consumed after the `await` — one microtask later than the
   * pre-neverthrow code, an already-accepted contract (see `_send`).
   */
  private async _tick(): Promise<void> {
    if (this._disposed || this._inFlight) return;

    const frame = this._receiveFrame().match(
      (value) => value,
      (error) => {
        this._recordTickError(error);
        return null;
      },
    );
    if (!frame) return;

    const sent = await this._sendTracked(frame);

    if (this._disposed) return;

    sent.match(
      (result) => {
        switch (result) {
          case "skipped":
            // Not a failure (e.g. destroyed target during teardown). Don't touch
            // the error counter and don't tick FPS.
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
      },
      (error) => {
        this._recordTickError(error);
      },
    );
  }

  /**
   * Poll the native receiver once. Returns `Ok(frame | null)` on the success
   * channel — `null` means no new frame, not a failure — or the typed
   * `FrameReceiveError` on the `Err` side. A pure producer: consumption
   * (recording against the circuit breaker, emitting) happens once, in
   * `_tick`, the single usage site.
   */
  private _receiveFrame(): Result<SharedTextureFrame | null, FrameReceiveError> {
    return safeReceiveSharedTexture(this.receiver);
  }

  /**
   * Run `_send()` with the `_inFlight` drop-latest flag held for its
   * duration. Awaiting a `ResultAsync` yields a `Result` — that's not
   * consumption, just unwrapping the promise; the `Result` still flows
   * through to `_tick`'s `.match()`.
   */
  private async _sendTracked(
    frame: SharedTextureFrame,
  ): Promise<
    Result<SendResult, UnsupportedPixelFormatError | TextureImportError | TextureDeliveryError>
  > {
    this._inFlight = true;
    try {
      return await this._send(frame);
    } finally {
      this._inFlight = false;
    }
  }

  private _send(
    frame: SharedTextureFrame,
  ): ResultAsync<
    SendResult,
    UnsupportedPixelFormatError | TextureImportError | TextureDeliveryError
  > {
    if (this.target.isDestroyed()) {
      // Target is gone — the handle is never imported; release it here.
      releaseNativeHandle(frame.handle);
      return okAsync("skipped");
    }

    // Single pipeline: prepare (sync) chains into delivery (async). No
    // consumption here — the combined Result/ResultAsync propagates to
    // `_tick`'s single `.match()`.
    return this._prepare(frame).asyncAndThen((imported) => this._deliver(imported));
  }

  /**
   * Validate the frame's pixel format and import it into Electron, then
   * release the native handle on BOTH outcomes. `importSharedTexture` never
   * takes ownership — it holds its own duplicated NT HANDLE / retained
   * IOSurface — so the receiver's reference must be released exactly once
   * after the import attempt, success or failure; skipping it leaks one NT
   * HANDLE / IOSurface retain per frame. `andTee` / `orTee` tap each side and
   * pass it through unchanged; exactly one of them runs, and the typed error
   * still propagates to the single `.match` consumer.
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
   * Deliver one imported texture to the target renderer. `sendImportedTexture`
   * releases `imported` on every path. Disposal mid-send maps the rejection
   * to `"skipped"` instead of an error, as before.
   */
  private _deliver(
    imported: Electron.SharedTextureImported,
  ): ResultAsync<SendResult, TextureDeliveryError> {
    const targetFrame = this.target.mainFrame;
    if (!targetFrame) {
      imported.release();
      return okAsync("skipped");
    }
    return ResultAsync.fromPromise(
      sendImportedTexture(targetFrame, imported, this.extraArgs),
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
 * `Ok` outcome of a single `_send()` call — pipeline failures (invalid pixel
 * format, `importSharedTexture` throw, `sendSharedTexture` rejection) ride
 * the `Err` channel instead (see `_prepare` / `_deliver`) and are consumed by
 * `_tick`.
 *
 * - `"delivered"`: frame reached `sendSharedTexture` and resolved. Resets the
 *   circuit-breaker counter and ticks FPS.
 * - `"skipped"`: an expected non-error path (target webContents destroyed, no
 *   mainFrame, disposed mid-send). Neither counts nor resets.
 */
type SendResult = "delivered" | "skipped";

/**
 * Create a shared-texture receiver bridge.
 *
 * The returned bridge polls Spout/Syphon at `pollIntervalMs` and delivers each
 * frame as a GPU-shared texture to `options.target`'s renderer. The renderer
 * must register a handler via `consumeSharedTexture` from
 * `@napolab/texture-bridge-renderer/client`.
 *
 * @throws {TypeError} `pollIntervalMs` was passed and is not a positive
 * finite number.
 * @throws when the native `TextureReceiver` cannot be constructed — most
 * commonly no sender is publishing under `senderName` yet.
 *
 * Construction is the only throwing step: `start()` / `stop()` /
 * `dispose()` / `setFlipY()` never throw, and every per-frame failure
 * arrives on `"error"` as `FrameReceiveError`, `TextureImportError`,
 * `TextureDeliveryError`, `UnsupportedPixelFormatError`, or
 * `ReceiverStoppedError` (emitted after 10 consecutive failures, which stops
 * the poll timer without disposing the bridge).
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
  return new SharedTextureReceiverBridgeImpl(receiver, target, extraArgs, pollIntervalMs);
};
