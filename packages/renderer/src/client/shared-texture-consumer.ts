/**
 * Renderer-side helper for consuming shared textures sent by
 * `createSharedTextureReceiver` in the main process.
 *
 * The module has two orthogonal exports:
 *
 * - `installSharedTextureReceiver()` — binds Electron's single
 *   `sharedTexture.setSharedTextureReceiver` slot to an internal
 *   `createMultiDispatcher` pool. Idempotent; call once at app startup.
 * - `consumeSharedTexture(handlers)` — registers one consumer into the pool.
 *   Purely a registration; performs no other side effects. Requires
 *   `installSharedTextureReceiver()` to have been called first.
 *
 * Every active consumer receives its own `VideoFrame` per incoming imported
 * texture. When no consumers are registered, the installed receiver still
 * drains incoming frames (`dispatcher.handler` returns `Promise.all([])`) and
 * releases the imported texture exactly once.
 *
 * Renderer process only.
 */

import { sharedTexture } from "electron";
import { toError } from "../to-error";
import { createMultiDispatcher } from "./multi-dispatcher";

export interface SharedTextureConsumerFrame {
  /** The imported shared texture's unique identifier (stable within process). */
  readonly textureId: string;
  /**
   * A `VideoFrame` backed by the shared texture. Call `.close()` when done —
   * `consumeSharedTexture` does this automatically after your handler returns.
   * Pass it to `GPUDevice.importExternalTexture({ source: videoFrame })` for a
   * zero-copy path to WebGPU.
   */
  readonly videoFrame: VideoFrame;
}

export interface SharedTextureConsumerHandlers {
  /**
   * Called once per delivered frame. Receive `frame.videoFrame` and either use
   * it synchronously or `await` async work before returning. The VideoFrame is
   * closed as soon as the handler's returned promise settles.
   *
   * Extra args passed by the main process's `sendSharedTexture(..., ...args)`
   * are forwarded verbatim.
   */
  onFrame(frame: SharedTextureConsumerFrame, ...args: unknown[]): void | Promise<void>;
  onError?(error: Error): void;
}

export interface SharedTextureConsumerRegistration {
  /** Remove this consumer from the pool. Idempotent. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Pool — one multi-dispatcher backing one Electron slot.
// ---------------------------------------------------------------------------

type DispatchArgs = readonly [Electron.ReceivedSharedTextureData, ...unknown[]];

const dispatcher = createMultiDispatcher<DispatchArgs, Promise<void>>({
  combine: async (results) => {
    await Promise.all(results);
  },
});

let receiverInstalled = false;
let notInstalledWarningShown = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Bind Electron's `sharedTexture.setSharedTextureReceiver` slot to the internal
 * consumer pool. Idempotent — subsequent calls are no-ops. Call once at
 * renderer startup, before any `consumeSharedTexture` call.
 *
 * The bound receiver stays in place for the lifetime of the renderer process.
 * It always delegates to the pool's dispatcher (a no-op when no consumers are
 * registered) and unconditionally releases the imported texture afterwards.
 *
 * @experimental Requires Electron 40+ `sharedTexture` module.
 */
export const installSharedTextureReceiver = (): void => {
  if (receiverInstalled) return;
  receiverInstalled = true;
  sharedTexture.setSharedTextureReceiver(async (data, ...args) => {
    const imported = data.importedSharedTexture;
    try {
      await dispatcher.handler(data, ...args);
    } finally {
      // Defer imported.release() to the next macrotask. sendSharedTexture
      // registers the renderer-frame reference in its tracker *after* it
      // receives our sync-token ACK from this transfer handler. If we release
      // synchronously here, the resulting RELEASE_RENDERER_TO_MAIN IPC can be
      // processed by main in the same tick as the ACK — the release handler
      // then runs before the ACK continuation microtask has updated the
      // tracker, and Electron throws
      // "Shared texture X is not referenced by renderer frame N", silently
      // leaking the tracker entry. One macrotask of slack puts the release
      // IPC on main's next tick, by which point microtasks have drained.
      setTimeout(() => {
        // A misbehaving consumer that called `.release()` inside its own
        // `onFrame` would otherwise throw here and kill the permanent slot
        // (DoS). Log and swallow so the slot stays healthy for every other
        // consumer.
        try {
          imported.release();
        } catch (err) {
          console.error(
            "[shared-texture] imported.release() threw (possibly double-released):",
            err,
          );
        }
      }, 0);
    }
  });
};

/**
 * Register a callback for imported shared textures delivered from the main
 * process via `createSharedTextureReceiver`.
 *
 * Multiple consumers may coexist. Each gets its own `VideoFrame` per incoming
 * imported texture; the underlying texture is released exactly once after all
 * consumers' `onFrame` callbacks have settled.
 *
 * Pre-condition: `installSharedTextureReceiver()` must have been called. This
 * function never touches the Electron receiver slot — its only job is to add
 * one entry to the consumer pool.
 *
 * @experimental Requires Electron 40+ `sharedTexture` module.
 */
export const consumeSharedTexture = (
  handlers: SharedTextureConsumerHandlers,
): SharedTextureConsumerRegistration => {
  if (!receiverInstalled && !notInstalledWarningShown) {
    notInstalledWarningShown = true;
    console.warn(
      "[consumeSharedTexture] Called before installSharedTextureReceiver(). Frames will not be delivered until install is called at renderer startup.",
    );
  }

  const unregister = dispatcher.register(async (data, ...args) => {
    const imported = data.importedSharedTexture;
    const videoFrame = imported.getVideoFrame();
    try {
      await handlers.onFrame({ textureId: imported.textureId, videoFrame }, ...args);
    } catch (err) {
      // A consumer whose `onError` itself throws must not crash the outer
      // try/finally (which would leak VideoFrame.close()).
      try {
        handlers.onError?.(toError(err));
      } catch (handlerErr) {
        console.error("[consumeSharedTexture] onError handler threw:", handlerErr);
      }
    } finally {
      try {
        videoFrame.close();
      } catch {
        // Consumer closed it already — ignore.
      }
    }
  });

  return { dispose: unregister };
};

// ---------------------------------------------------------------------------
// Test-only helpers.
// ---------------------------------------------------------------------------

/**
 * Clear the consumer pool AND the "receiver installed" flag. Used by vitest
 * suites to return the module to its pre-install state; not part of the
 * public API. Production code never resets — the slot is permanent.
 *
 * @internal
 */
export const _resetSharedTextureRegistryForTesting = (): void => {
  dispatcher.reset();
  receiverInstalled = false;
  notInstalledWarningShown = false;
};
