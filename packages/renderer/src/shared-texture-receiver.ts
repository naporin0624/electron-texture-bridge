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
import { FpsCounter } from "./fps-counter";
import { toError } from "./to-error";

/**
 * Safely release a native shared-texture handle that was minted by the native
 * receiver but never consumed by Electron's `importSharedTexture`. Any throw
 * here would break the bridge poll loop, so we log and swallow.
 */
const releaseUnconsumedHandle = (handle: Buffer): void => {
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
   * resources is the caller's responsibility.
   */
  private _recordTickError(error: Error): void {
    this.emit("error", error);
    this._countTickError();
  }

  /**
   * Count a tick-level error without re-emitting. Used when `_send()` already
   * emitted the error itself (so we don't emit twice) but the failure should
   * still count toward the circuit breaker.
   */
  private _countTickError(): void {
    this._consecutiveErrors += 1;
    if (this._consecutiveErrors >= MAX_CONSECUTIVE_TICK_ERRORS) {
      this.stop();
      this.emit(
        "error",
        new Error(
          `shared texture receiver stopped after ${MAX_CONSECUTIVE_TICK_ERRORS} consecutive errors`,
        ),
      );
    }
  }

  /**
   * One poll tick. Drop-latest: if a previous send is still in flight (the
   * Electron `sendSharedTexture` Promise has not resolved yet), this tick is a
   * no-op. That keeps at most one imported-texture reference alive on the main
   * process at any time and prevents frame pile-up when the renderer is slow.
   */
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

  private async _send(frame: SharedTextureFrame): Promise<SendResult> {
    if (this.target.isDestroyed()) {
      // Target is gone — handle was minted but Electron will never consume it.
      // Release it directly via the native helper so we don't leak
      // NT HANDLE / IOSurface per frame during window teardown.
      releaseUnconsumedHandle(frame.handle);
      return "skipped";
    }

    if (!isValidPixelFormat(frame.pixelFormat)) {
      const error = new Error(
        `shared texture frame has unsupported pixelFormat "${frame.pixelFormat}" (expected one of ${VALID_PIXEL_FORMATS.join(", ")})`,
      );
      this.emit("error", error);
      // Handle was minted but will never reach importSharedTexture — release it
      // here to avoid leaking an NT HANDLE / IOSurface on unknown pixelFormat.
      releaseUnconsumedHandle(frame.handle);
      return "failed";
    }

    // Wrap the raw handle under the platform-specific key that Electron's
    // SharedTextureHandle expects.
    const handle =
      process.platform === "win32" ? { ntHandle: frame.handle } : { ioSurface: frame.handle };

    const textureInfo: Electron.SharedTextureImportTextureInfo = {
      codedSize: { width: frame.width, height: frame.height },
      handle,
      pixelFormat: frame.pixelFormat,
    };

    const imported = this._importFrame(textureInfo, frame.handle);
    if (!imported) return "failed";

    const targetFrame = this.target.mainFrame;
    if (!targetFrame) {
      imported.release();
      return "skipped";
    }

    try {
      await sharedTexture.sendSharedTexture(
        { frame: targetFrame, importedSharedTexture: imported },
        ...this.extraArgs,
      );
      return "delivered";
    } catch (err) {
      if (this._disposed) return "skipped";
      this.emit("error", toError(err));
      return "failed";
    } finally {
      imported.release();
    }
  }

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
}

/**
 * Outcome of a single `_send()` call.
 *
 * - `"delivered"`: frame reached `sendSharedTexture` and resolved. Resets the
 *   circuit-breaker counter and ticks FPS.
 * - `"failed"`: a user-visible pipeline error fired (invalid pixel format,
 *   `importSharedTexture` threw, `sendSharedTexture` rejected). Counts toward
 *   the circuit breaker.
 * - `"skipped"`: an expected non-error path (target webContents destroyed, no
 *   mainFrame, disposed mid-send). Neither counts nor resets.
 */
type SendResult = "delivered" | "failed" | "skipped";

/**
 * Create a shared-texture receiver bridge.
 *
 * The returned bridge polls Spout/Syphon at `pollIntervalMs` and delivers each
 * frame as a GPU-shared texture to `options.target`'s renderer. The renderer
 * must register a handler via `consumeSharedTexture` from
 * `@napolab/texture-bridge-renderer/client`.
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
