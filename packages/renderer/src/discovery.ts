import { EventEmitter } from "events";
import { listSenders } from "@napolab/texture-bridge-core";
import type { SenderInfo } from "@napolab/texture-bridge-core";
import { Result } from "neverthrow";
import { toError } from "./to-error";

export interface SenderDiscoveryEvents {
  updated: [senders: SenderInfo[]];
  added: [senders: SenderInfo[]];
  removed: [senders: SenderInfo[]];
  error: [error: Error];
}

/** `listSenders` with its throw folded into a Result, bound once at module scope. */
const safeListSenders = Result.fromThrowable(listSenders, toError);

export class SenderDiscovery extends EventEmitter {
  private _senders: SenderInfo[] = [];
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _disposed = false;

  get isDisposed(): boolean {
    return this._disposed;
  }

  start(intervalMs = 1000): void {
    if (this._disposed || this._timer) return;
    this._timer = setInterval(() => this._refresh(), intervalMs);
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  getSenders(): SenderInfo[] {
    return [...this._senders];
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stop();
    this.removeAllListeners();
  }

  private _refresh(): void {
    if (this._disposed) return;

    safeListSenders().match(
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

  private _isSame(a: SenderInfo, b: SenderInfo): boolean {
    // If both have UUIDs, compare by UUID
    if (a.uuid && b.uuid) return a.uuid === b.uuid;
    // Otherwise compare by name + appName
    return a.name === b.name && a.appName === b.appName;
  }
}
