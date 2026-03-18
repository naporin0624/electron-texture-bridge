import { EventEmitter } from "events";
import { TextureReceiver } from "@napolab/texture-bridge-core";
import type { ReceivedFrame } from "@napolab/texture-bridge-core";
import { FpsCounter } from "./fps-counter";

export interface TextureReceiverBridgeOptions {
  senderName: string;
  appName?: string;
  serverUuid?: string;
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
  dispose(): void;
  readonly isDisposed: boolean;
}

class TextureReceiverBridgeImpl extends EventEmitter implements TextureReceiverBridge {
  private receiver: InstanceType<typeof TextureReceiver>;
  private fpsCounter = new FpsCounter();
  private _disposed = false;
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
    if (this._disposed || this._timer) return;
    this.fpsCounter.reset();
    this._timer = setInterval(() => this._poll(), this.pollIntervalMs);
  }

  stop(): void {
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

  private _poll(): void {
    if (this._disposed) return;

    try {
      if (!this.receiver.hasNewFrame()) return;

      const frame = this.receiver.receiveFrame();
      if (!frame) return;

      this.emit("frame", frame);

      const fps = this.fpsCounter.tick();
      if (fps !== null) {
        this.emit("fps", fps);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    }
  }
}

export function createTextureReceiver(
  options: TextureReceiverBridgeOptions,
): TextureReceiverBridge {
  const { senderName, appName, serverUuid, pollIntervalMs = 16 } = options;
  const receiver = new TextureReceiver(senderName, appName, serverUuid);
  return new TextureReceiverBridgeImpl(receiver, pollIntervalMs);
}
