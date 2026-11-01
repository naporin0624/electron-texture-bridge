/**
 * Renderer-side helper for consuming shared textures sent by
 * `createSharedTextureReceiver` (or `TextureBridge.forwardFrames`) in the main
 * process.
 *
 * `bindSharedTextureReceiver(sharedTexture)` binds Electron's single
 * `sharedTexture.setSharedTextureReceiver` slot to a consumer pool (one
 * `createMultiDispatcher` per binding) and returns a handle:
 *
 * - `consume(handlers)` — registers one consumer into that binding's pool.
 *   Purely a registration; never touches the Electron slot.
 * - `dispose()` — tears the binding down. Idempotent.
 *
 * The `sharedTexture` module is injected rather than imported so the binding
 * has an explicit owner and lifetime (and so tests can pass a fake). Binding
 * the same target twice without disposing throws
 * `SharedTextureReceiverAlreadyBoundError`.
 *
 * Every active consumer receives its own `VideoFrame` per incoming imported
 * texture. When no consumers are registered — including after `dispose()` —
 * the installed receiver still drains incoming frames (`dispatcher.handler`
 * returns `Promise.all([])`) and releases the imported texture exactly once.
 *
 * Renderer process only.
 */

import {
  SharedTextureReceiverAlreadyBoundError,
  SharedTextureReceiverDisposedError,
} from "../errors";
import { toError } from "../to-error";
import { createMultiDispatcher } from "./multi-dispatcher";
import type { MultiDispatcher } from "./multi-dispatcher";

export interface SharedTextureConsumerFrame {
  /** The imported shared texture's unique identifier (stable within process). */
  readonly textureId: string;
  /**
   * A `VideoFrame` backed by the shared texture. Call `.close()` when done —
   * `consume()` does this automatically after your handler returns.
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

/**
 * The slice of Electron's renderer `sharedTexture` module that
 * {@link bindSharedTextureReceiver} needs. Pass Electron's `sharedTexture`
 * itself; tests may pass `{ setSharedTextureReceiver: vi.fn() }`.
 */
export type SharedTextureReceiverTarget = Pick<Electron.SharedTexture, "setSharedTextureReceiver">;

/** Handle returned by {@link bindSharedTextureReceiver}. */
export interface BoundSharedTextureReceiver {
  /**
   * Register a callback for imported shared textures delivered to the bound
   * target.
   *
   * Multiple consumers may coexist. Each gets its own `VideoFrame` per
   * incoming imported texture; the underlying texture is released exactly
   * once after all consumers' `onFrame` callbacks have settled.
   *
   * @throws {SharedTextureReceiverDisposedError} this binding was disposed.
   */
  consume(handlers: SharedTextureConsumerHandlers): SharedTextureConsumerRegistration;
  /**
   * Tear the binding down. Idempotent.
   *
   * Drops every registered consumer and frees the target so it can be bound
   * again. Electron has no API to unset the receiver, so the installed
   * callback stays and keeps draining (releasing) frames that still arrive;
   * a later `bindSharedTextureReceiver` on the same target replaces it
   * (Electron's slot is last-wins).
   */
  dispose(): void;
}

type DispatchArgs = readonly [Electron.ReceivedSharedTextureData, ...unknown[]];

type Dispatcher = MultiDispatcher<DispatchArgs, Promise<void>>;

/**
 * Targets with a live (not yet disposed) binding. Keyed on the injected
 * object, so distinct targets bind independently and a disposed target can be
 * bound again.
 */
const boundTargets = new WeakSet<SharedTextureReceiverTarget>();

const createConsumerPool = (): Dispatcher =>
  createMultiDispatcher<DispatchArgs, Promise<void>>({
    combine: async (results) => {
      await Promise.all(results);
    },
  });

/**
 * Install the permanent Electron receiver callback for one binding. It always
 * delegates to the binding's dispatcher (a no-op when no consumers are
 * registered) and unconditionally releases the imported texture afterwards.
 */
const installReceiver = (target: SharedTextureReceiverTarget, dispatcher: Dispatcher): void => {
  target.setSharedTextureReceiver(async (data, ...args) => {
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

/** Add one consumer to a binding's pool. Never touches the Electron slot. */
const registerConsumer = (
  dispatcher: Dispatcher,
  handlers: SharedTextureConsumerHandlers,
): SharedTextureConsumerRegistration => {
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
        console.error("[shared-texture] onError handler threw:", handlerErr);
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

/**
 * Bind Electron's `sharedTexture.setSharedTextureReceiver` slot to a fresh
 * consumer pool and return a handle to register consumers and tear down.
 *
 * Call once at renderer startup with Electron's `sharedTexture` module:
 *
 * ```ts
 * import { sharedTexture } from "electron";
 * const receiver = bindSharedTextureReceiver(sharedTexture);
 * const reg = receiver.consume({ onFrame: ({ videoFrame }) => draw(videoFrame) });
 * ```
 *
 * @throws {SharedTextureReceiverAlreadyBoundError} `target` already has a live
 * binding (dispose it first).
 *
 * @experimental Requires Electron 40+ `sharedTexture` module.
 */
export const bindSharedTextureReceiver = (
  target: SharedTextureReceiverTarget,
): BoundSharedTextureReceiver => {
  if (boundTargets.has(target)) throw new SharedTextureReceiverAlreadyBoundError();

  const dispatcher = createConsumerPool();
  installReceiver(target, dispatcher);
  // Mark as bound only after the install succeeded, so a throwing
  // `setSharedTextureReceiver` does not leave the target permanently locked.
  boundTargets.add(target);

  let disposed = false;

  return {
    consume(handlers) {
      if (disposed) throw new SharedTextureReceiverDisposedError();
      return registerConsumer(dispatcher, handlers);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      boundTargets.delete(target);
      dispatcher.reset();
    },
  };
};
