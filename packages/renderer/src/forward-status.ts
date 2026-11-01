/**
 * Forward-status helpers shared by every `forwardFrames` implementation
 * (`TextureBridge` and `SharedTextureReceiverBridge`), so the status shape,
 * observer isolation and listener hygiene live in exactly one place.
 */

import type { WebContents } from "electron";
import type { ForwardDefect } from "@napolab/texture-bridge-core/electron";
import type { ForwardStatus } from "./types";
/**
 * Widen one frame's outcome into the public state shape. Module scope and
 * pure so the branch that decides whether a `cause` exists is testable and
 * lives in exactly one place — `target-destroyed` is the only defect without
 * one, so it cannot be spread in blindly.
 */
export const toForwardStatus = (defect: ForwardDefect | undefined): ForwardStatus => {
  if (defect === undefined) return { ok: true };
  if (defect.reason === "target-destroyed") return { ok: false, reason: defect.reason };
  return { ok: false, reason: defect.reason, cause: defect.cause };
};

/**
 * Hand a status to one best-effort observer, swallowing whatever it throws.
 * Both sinks (`onStatus` and the `forwardStatus` event) run inside a promise
 * continuation, where an escaping throw becomes an unhandled rejection in the
 * main process — and neither sink is allowed to break frame forwarding. The
 * `"error"` event is deliberately not used to report this: it throws when
 * nobody is listening, which is exactly the situation a diagnostic channel
 * has to survive.
 */
export const notifyForwardObserver = (deliver: () => void, label: string): void => {
  try {
    deliver();
  } catch (err) {
    console.error(`[texture-bridge] ${label} threw:`, err);
  }
};

/**
 * Remove a `forwardFrames` entry's "destroyed" listener from its target.
 * Module scope so the dependency (the entry) is an explicit argument — no
 * inner function declarations. Guarded with `isDestroyed()` because
 * `removeListener` can throw once the underlying WebContents itself has
 * been destroyed; on a dead target the listener has either already fired
 * and self-removed via `once`, or removing it is moot either way, so
 * skipping is safe in both cases.
 */
export const unhookDestroyedListener = (entry: {
  readonly target: WebContents;
  readonly onDestroyed: () => void;
}): void => {
  if (entry.target.isDestroyed()) return;
  entry.target.removeListener("destroyed", entry.onDestroyed);
};
