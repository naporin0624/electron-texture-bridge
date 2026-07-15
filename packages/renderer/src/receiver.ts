import { EventEmitter } from "events";
import { TextureReceiver } from "@napolab/texture-bridge-core";
import type { ReceivedFrame } from "@napolab/texture-bridge-core";
import { FpsCounter } from "./fps-counter";
import { toError } from "./to-error";

export interface TextureReceiverBridgeOptions {
  senderName: string;
  appName?: string;
  serverUuid?: string;
  /** Polling interval in ms. Defaults to 16 (~60 fps). */
  pollIntervalMs?: number;
}

export interface ReceiverBridgeEvents {
  frame: [frame: ReceivedFrame];
  fps: [fps: number];
  error: [error: Error];
  disposed: [];
}

export interface TextureReceiverBridge {
  on<K extends keyof ReceiverBridgeEvents>(
    event: K,
    listener: (...args: ReceiverBridgeEvents[K]) => void,
  ): this;
  off<K extends keyof ReceiverBridgeEvents>(
    event: K,
    listener: (...args: ReceiverBridgeEvents[K]) => void,
  ): this;
  once<K extends keyof ReceiverBridgeEvents>(
    event: K,
    listener: (...args: ReceiverBridgeEvents[K]) => void,
  ): this;

  start(): void;
  stop(): void;
  /** Tear down all resources. Terminal operation — the bridge cannot be reused afterward. */
  dispose(): void;
  /** Alias for dispose(), enabling `using receiver = createTextureReceiver(...)` */
  [Symbol.dispose](): void;
  readonly isDisposed: boolean;
}

class TextureReceiverBridgeImpl extends EventEmitter implements TextureReceiverBridge {
  private receiver: InstanceType<typeof TextureReceiver>;
  private fpsCounter = new FpsCounter();
  private _disposed = false;
  private _started = false;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;

  constructor(receiver: InstanceType<typeof TextureReceiver>, pollIntervalMs: number) {
    super();
    this.receiver = receiver;
    this.pollIntervalMs = pollIntervalMs;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  start(): void {
    if (this._disposed || this._started) return;
    this._started = true;
    this.fpsCounter.reset();

    this._timer = setInterval(() => this._poll(), this.pollIntervalMs);
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

  private _onFrame(frame: ReceivedFrame): void {
    try {
      this.emit("frame", frame);
      const fps = this.fpsCounter.tick();
      if (fps !== null) {
        this.emit("fps", fps);
      }
    } catch (err) {
      this.emit("error", toError(err));
    }
  }

  private _poll(): void {
    if (this._disposed) return;

    try {
      const frame = this.receiver.receiveFrame();
      if (!frame) return;
      this._onFrame(frame);
    } catch (err) {
      this.emit("error", toError(err));
    }
  }
}

export const createTextureReceiver = (
  options: TextureReceiverBridgeOptions,
): TextureReceiverBridge => {
  const { senderName, appName, serverUuid, pollIntervalMs = 16 } = options;
  const receiver = new TextureReceiver(senderName, appName, serverUuid);
  return new TextureReceiverBridgeImpl(receiver, pollIntervalMs);
};
