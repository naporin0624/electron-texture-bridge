import { EventEmitter } from "events";
import { app, BrowserWindow, screen, type Event, type WebContents } from "electron";
import {
  TextureSender,
  sendTextureFromPaintEvent,
  type PaintTexture,
  type PaintDefect,
} from "@napolab/texture-bridge-core";
import { forwardSharedTexture, type ForwardDefect } from "@napolab/texture-bridge-core/electron";
import { PreviewManager } from "./preview-manager";
import { FpsCounter } from "./fps-counter";
import type {
  TextureBridgeOptions,
  TextureBridge,
  ForwardStatus,
  ForwardStatusEvent,
  FrameForward,
  FrameForwardOptions,
} from "./types";
import { toError } from "./to-error";

/**
 * Convert a pixel-space size to a device-independent (DIP) size for a given
 * display scaleFactor. Used when `pixelExact: true` is set so the offscreen
 * BrowserWindow's DIP size produces the requested framebuffer pixel count.
 *
 * Math.round (rather than floor / ceil) minimizes the rounding error when the
 * scaleFactor does not divide the pixel size evenly (e.g., 1920 / 1.75 =
 * 1097.14 → 1097 → 1097 × 1.75 = 1919.75, which Chromium typically rounds
 * back to 1920).
 */
export const computeDipSize = (
  pixelWidth: number,
  pixelHeight: number,
  scaleFactor: number,
): { width: number; height: number } => {
  if (scaleFactor <= 0) {
    return { width: Math.max(1, pixelWidth), height: Math.max(1, pixelHeight) };
  }
  return {
    width: Math.max(1, Math.round(pixelWidth / scaleFactor)),
    height: Math.max(1, Math.round(pixelHeight / scaleFactor)),
  };
};

/**
 * How the OSR compositor maps the window's DIP size to the shared-texture
 * pixel size.
 *
 * - `"device-scale"` (Electron ≤ 40): the paint framebuffer is
 *   `DIP × display.scaleFactor`, and `webPreferences.offscreen.deviceScaleFactor`
 *   is ignored — `pixelExact` must pre-divide the window size to hit an exact
 *   pixel count.
 * - `"unit-scale"` (Electron ≥ 41): `offscreen.deviceScaleFactor` is honored
 *   (and defaults to 1.0 from Electron 42), so we pin it to 1 and DIP == px
 *   holds deterministically — no DIP division, `pixelExact` is trivially
 *   satisfied.
 *
 * Empirical basis: reports/2026-08-11-pixelexact-osr-scale-investigation.md
 * (measured on Electron 40.2.1 / 41.10.4 / 42.4.0, macOS Retina scaleFactor 2).
 */
export type OsrScalePolicy = "device-scale" | "unit-scale";

/** Parse the Electron major version; 0 when missing or malformed. */
export const resolveElectronMajor = (versions: { electron?: string }): number => {
  const [major] = (versions.electron ?? "").split(".");
  const parsed = parseInt(major ?? "", 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** `offscreen.deviceScaleFactor` exists (and is honored) from Electron 41. */
export const resolveOsrScalePolicy = (electronMajor: number): OsrScalePolicy =>
  electronMajor >= 41 ? "unit-scale" : "device-scale";

/**
 * Window DIP size for the requested pixel size under the given policy.
 * Under unit-scale DIP == px, so the size passes through; under device-scale
 * only `pixelExact` pre-divides by the display scaleFactor (legacy behavior).
 */
export const resolveWindowDipSize = (
  options: Pick<TextureBridgeOptions, "width" | "height" | "pixelExact">,
  policy: OsrScalePolicy,
  scaleFactor: number,
): { width: number; height: number } => {
  if (policy === "unit-scale") return { width: options.width, height: options.height };
  if (options.pixelExact === true)
    return computeDipSize(options.width, options.height, scaleFactor);
  return { width: options.width, height: options.height };
};

interface PaintEvent extends Event {
  texture?: PaintTexture;
}

/**
 * One `forwardFrames` registration. `lastStatus` is the only mutable field —
 * it is the dedupe cursor that turns a per-frame result stream into the
 * state-change stream `forwardStatus` / `onStatus` promise to deliver.
 */
interface ForwardEntry {
  readonly target: WebContents;
  readonly extraArgs: readonly unknown[];
  readonly onStatus?: (status: ForwardStatus) => void;
  readonly onDestroyed: () => void;
  /** Last reported state, or `null` before the first frame settles. */
  lastStatus: "ok" | ForwardDefect["reason"] | null;
}

/**
 * Widen one frame's outcome into the public state shape. Module scope and
 * pure so the branch that decides whether a `cause` exists is testable and
 * lives in exactly one place — `target-destroyed` is the only defect without
 * one, so it cannot be spread in blindly.
 */
const toForwardStatus = (defect: ForwardDefect | undefined): ForwardStatus => {
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
const notifyForwardObserver = (deliver: () => void, label: string): void => {
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
const unhookDestroyedListener = (entry: {
  readonly target: WebContents;
  readonly onDestroyed: () => void;
}): void => {
  if (entry.target.isDestroyed()) return;
  entry.target.removeListener("destroyed", entry.onDestroyed);
};

/**
 * Injectable constructors for {@link createTextureBridgeWith}. Lets tests and
 * embedders substitute the two heavyweight resources — the offscreen
 * BrowserWindow and the native TextureSender — with doubles (the pattern
 * consumers previously built themselves as `createDeckWith(createBridge)`).
 * Note: the factory still consults Electron's `app` / `screen` globals and
 * constructs the preview window directly, so a fully Electron-free test
 * environment additionally needs those mocked.
 * Future dependencies will be added as optional fields, so object literals
 * passing only these two members keep compiling.
 */
export interface TextureBridgeDeps {
  createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
  createSender: (name: string, width: number, height: number) => InstanceType<typeof TextureSender>;
}

/** Exported for unit tests — not part of the package's public entry point. */
export class TextureBridgeImpl extends EventEmitter implements TextureBridge {
  private _renderWindow: BrowserWindow;
  private sender: InstanceType<typeof TextureSender>;
  private previewManager: PreviewManager | null;
  private fpsCounter = new FpsCounter();
  private _disposed = false;
  private lastDropReason: PaintDefect["reason"] | null = null;
  private options: TextureBridgeOptions;
  private readonly policy: OsrScalePolicy;
  private readonly createSender: TextureBridgeDeps["createSender"];
  private readonly forwardEntries = new Set<ForwardEntry>();

  constructor(
    renderWindow: BrowserWindow,
    sender: InstanceType<typeof TextureSender>,
    previewManager: PreviewManager | null,
    options: TextureBridgeOptions,
    policy: OsrScalePolicy = resolveOsrScalePolicy(resolveElectronMajor(process.versions)),
    createSender: TextureBridgeDeps["createSender"] = (name, width, height) =>
      new TextureSender(name, width, height),
  ) {
    super();
    this._renderWindow = renderWindow;
    this.sender = sender;
    this.previewManager = previewManager;
    this.options = options;
    this.policy = policy;
    this.createSender = createSender;
  }

  get renderWindow(): BrowserWindow {
    return this._renderWindow;
  }

  get previewWindow(): BrowserWindow | null {
    return this.previewManager?.window ?? null;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  get droppedReason(): PaintDefect["reason"] | null {
    return this.lastDropReason;
  }

  /** Emit `frameDropped`, deduping consecutive drops with the same reason. */
  private emitFrameDropped(defect: PaintDefect): void {
    if (defect.reason === this.lastDropReason) return;
    this.lastDropReason = defect.reason;
    this.emit("frameDropped", defect);
  }

  /**
   * Record one frame's forward outcome for `entry` and announce it only when
   * it differs from the last announced one — the first success, the first
   * failure, a change of failure reason, and the recovery back to success.
   * At 30fps a stuck target would otherwise emit 30 identical events a
   * second (same dedupe stance as `frameDropped`).
   */
  private settleForward(entry: ForwardEntry, defect: ForwardDefect | undefined): void {
    // A result that lands after the registration was disposed (or pruned by
    // the target's "destroyed" event) describes a forward nobody owns
    // anymore — reporting it would resurrect a dead handle in the log.
    if (!this.forwardEntries.has(entry)) return;
    const next = defect?.reason ?? "ok";
    if (next === entry.lastStatus) return;
    entry.lastStatus = next;

    const status = toForwardStatus(defect);
    notifyForwardObserver(() => entry.onStatus?.(status), "forwardFrames onStatus");
    const event: ForwardStatusEvent = { ...status, extraArgs: entry.extraArgs };
    notifyForwardObserver(() => this.emit("forwardStatus", event), "forwardStatus listener");
  }

  /** Handle a paint event from the offscreen BrowserWindow. */
  handlePaint(event: { texture?: PaintTexture }): void {
    const texture = event.texture;
    // If we've been disposed between the paint event and this callback, the
    // underlying sender has been stopped and calling into it would throw
    // "TextureSender has been stopped" for every in-flight paint. Drop the
    // texture cleanly instead of emitting a stream of teardown errors.
    if (this._disposed) {
      texture?.release?.();
      return;
    }

    if (!texture?.textureInfo) {
      texture?.release?.();
      this.emitFrameDropped({ reason: "no-texture" });
      return;
    }

    try {
      // Best-effort monitors: the primitive reports defects, this driver
      // turns them into `forwardStatus` transitions instead of dropping them
      // — a silently dead forward is indistinguishable from a healthy one at
      // every other layer (paint, sender and preview all keep working).
      // Independent of the native Syphon/Spout send — this runs before
      // sendTextureFromPaintEvent so a native send throw cannot suppress a
      // monitor forward. Each call must START synchronously — the paint
      // texture is released in the finally below; the primitive's
      // import/send dispatch runs before its first await.
      for (const entry of this.forwardEntries) {
        // The primitive cannot reject today, but the best-effort contract
        // must not depend on another package's discipline — an unhandled
        // rejection would surface in the main process. A rejection is
        // reported as `send-failed`: it can only escape from the send half,
        // the import half is already wrapped in a Result by the primitive.
        void forwardSharedTexture(texture.textureInfo, entry.target, entry.extraArgs)
          .then((defect) => {
            this.settleForward(entry, defect);
          })
          .catch((err: unknown) => {
            this.settleForward(entry, { reason: "send-failed", cause: toError(err) });
          });
      }

      const defect = sendTextureFromPaintEvent(this.sender, texture.textureInfo);
      if (defect === undefined) {
        this.lastDropReason = null;
      } else {
        this.emitFrameDropped(defect);
      }
      this.previewManager?.sendFrame(texture);
    } catch (err) {
      this.emit("error", toError(err));
    } finally {
      texture.release?.();
    }

    if (this._disposed) return;
    const fps = this.fpsCounter.tick();
    if (fps !== null) {
      this.emit("fps", fps);
    }
  }

  openPreview(): void {
    if (this._disposed) return;
    if (!this.previewManager) {
      this.previewManager = new PreviewManager(
        this.options.width,
        this.options.height,
        this.options.preview,
      );
    }
    this.previewManager.open();
  }

  closePreview(): void {
    this.previewManager?.close();
  }

  forwardFrames(target: WebContents, options?: FrameForwardOptions): FrameForward {
    // Post-dispose registration would retain `target` in forwardEntries
    // forever — dispose() only clears the set once, at teardown time — so a
    // caller that registers after dispose gets an inert handle instead of a
    // silent leak. An already-destroyed target has the same failure mode
    // from the other direction: `once("destroyed", ...)` below would never
    // fire for a target that's already dead, so the entry would never
    // self-prune either — reject it up front instead.
    // `active: false` is the only trace a refused registration leaves —
    // without it the caller wires up a forward, gets a handle, and waits
    // forever for frames that were never going to come.
    if (this._disposed || target.isDestroyed()) return { dispose: () => {}, active: false };

    // `entry` closes over itself via `onDestroyed` — safe despite the
    // apparent forward reference: the closure only runs once `target`
    // fires "destroyed", by which point `entry` has long been assigned.
    const entry: ForwardEntry = {
      target,
      extraArgs: options?.extraArgs ?? [],
      onStatus: options?.onStatus,
      onDestroyed: (): void => {
        this.forwardEntries.delete(entry);
      },
      lastStatus: null,
    };
    this.forwardEntries.add(entry);

    // Auto-prune when the target WebContents is destroyed out from under us
    // (e.g. its window closes without the caller ever calling dispose()) —
    // otherwise the entry (and its WebContents reference) sits in
    // forwardEntries forever, and every subsequent handlePaint calls
    // forwardSharedTexture against an already-destroyed target.
    target.once("destroyed", entry.onDestroyed);

    // Membership in the set IS the liveness of this registration — reading
    // it through a getter keeps `active` honest for the two teardowns the
    // caller never initiates: the target being destroyed, and the bridge
    // being disposed. Captured as a local because an object-literal getter
    // does not inherit the enclosing `this`.
    const entries = this.forwardEntries;

    return {
      dispose: () => {
        this.forwardEntries.delete(entry);
        // This matters when the same long-lived `target` (e.g. the
        // multiviewer window) is registered and disposed repeatedly across
        // connect/disconnect cycles — without unhooking here, each cycle
        // leaves a dangling "destroyed" listener on that target.
        unhookDestroyedListener(entry);
      },
      get active(): boolean {
        return entries.has(entry);
      },
    };
  }

  resize(width: number, height: number): void {
    if (this._disposed) return;

    const prevOpts = this.options;
    this.options = { ...this.options, width, height };

    // 1. Resize offscreen BrowserWindow. Under `"unit-scale"` DIP == px, so the
    //    requested size passes through; under `"device-scale"` `pixelExact`
    //    pre-divides by the primary display's scaleFactor.
    const dip = resolveWindowDipSize(
      this.options,
      this.policy,
      screen.getPrimaryDisplay().scaleFactor,
    );
    this._renderWindow.setSize(dip.width, dip.height);

    // 2. Recreate native sender with new dimensions.
    //    Must stop the old sender first — Spout requires unique sender names.
    //    Sender always stays in pixel-space regardless of pixelExact.
    //    If the new sender fails, restore one with the original dimensions.
    this.sender.stop();
    try {
      this.sender = this.createSender(this.options.name, width, height);
    } catch (err) {
      this.options = prevOpts;
      const prevDip = resolveWindowDipSize(
        prevOpts,
        this.policy,
        screen.getPrimaryDisplay().scaleFactor,
      );
      this._renderWindow.setSize(prevDip.width, prevDip.height);
      this.sender = this.createSender(prevOpts.name, prevOpts.width, prevOpts.height);
      throw err;
    }

    // 3. Update preview canvas size
    this.previewManager?.updateSize(width, height);

    this.emit("resize", width, height);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // Destroy the offscreen window synchronously. `close()` is async and
    // cancellable — it loses the race against `before-quit`, letting Chromium
    // SIGKILL the OSR renderer and pop a crash dialog. Both known consumers
    // independently worked around this by forcing `destroy()`; a hidden
    // offscreen window has no user-facing close semantics to honor.
    if (!this._renderWindow.isDestroyed()) {
      this._renderWindow.destroy();
    }

    // Unhook every entry's "destroyed" listener before clearing — otherwise
    // it stays registered on a caller-owned, possibly long-lived
    // WebContents (e.g. the multiviewer window) forever, retaining this
    // disposed bridge instance and eventually tripping
    // MaxListenersExceededWarning across repeated create/dispose cycles.
    for (const entry of this.forwardEntries) {
      unhookDestroyedListener(entry);
    }
    this.forwardEntries.clear();
    this.sender.stop();
    this.previewManager?.dispose();
    this.previewManager = null;

    this.emit("disposed");
    this.removeAllListeners();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/**
 * Build the BrowserWindow constructor options for the offscreen renderer.
 *
 * Extracted as a pure function so it can be unit tested without touching
 * Electron's native module — the actual construction happens through
 * `TextureBridgeDeps.createWindow` — `createTextureBridge` binds it to
 * `new BrowserWindow(...)`.
 *
 * `options.includeAlpha` flips the OSR pipeline into alpha-preserving mode:
 * `transparent: true` plus `backgroundColor: "#00000000"` on the BrowserWindow
 * is the documented recipe for Chromium to emit per-pixel alpha into the
 * shared texture. The page itself must use a transparent background
 * (`html, body { background: transparent }`) for the alpha to mean anything.
 *
 * `policy` selects the `offscreen` prefs and `enableLargerThanScreen` gating:
 * under `"unit-scale"` `deviceScaleFactor` is pinned to 1 and
 * `enableLargerThanScreen` is always set (the DIP size equals the requested
 * pixel size, which may exceed the display's work area); under
 * `"device-scale"` behavior is unchanged from before this option existed.
 */
export const buildBrowserWindowOptions = (
  options: TextureBridgeOptions,
  policy: OsrScalePolicy,
): Electron.BrowserWindowConstructorOptions => {
  const { width, height, webPreferences, includeAlpha, pixelExact } = options;

  const offscreen =
    policy === "unit-scale"
      ? { useSharedTexture: true, deviceScaleFactor: 1 }
      : { useSharedTexture: true };
  const largerThanScreen = policy === "unit-scale" || pixelExact === true;

  return {
    width,
    height,
    show: false,
    // `enableLargerThanScreen` is documented as macOS-only but is harmless on
    // other platforms. Under unit-scale the DIP size equals the requested pixel
    // size — which may exceed the display work area — so it is always set;
    // under device-scale it is set only when `pixelExact` requests it.
    ...(largerThanScreen ? { enableLargerThanScreen: true } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen,
      ...webPreferences,
    },
    // Hex `#RRGGBBAA` with alpha=0x00 is the explicit "fully transparent
    // backdrop" signal Chromium honors on offscreen render surfaces. The
    // `transparent: true` flag alone leaves the compositor painting opaque,
    // so both keys must be applied together.
    ...(includeAlpha ? { transparent: true, backgroundColor: "#00000000" } : {}),
  };
};

/**
 * Create a fully-wired texture bridge: offscreen window, native sender,
 * optional preview, and FPS tracking.
 *
 * Must be called after `app.whenReady()`.
 *
 * Async, so it never throws synchronously — every failure below is a
 * rejection of the returned promise:
 * - called before `app.whenReady()`
 * - the native `TextureSender` cannot be constructed (name collision, device
 *   failure)
 * - `rendererUrl` fails to load
 *
 * Once the bridge exists, per-frame failures no longer reject or throw: they
 * arrive on `"error"` (`TextureSendError`) and `"frameDropped"`
 * (`PaintDefect`).
 */
export const createTextureBridgeWith =
  (deps: TextureBridgeDeps) =>
  async (options: TextureBridgeOptions): Promise<TextureBridge> => {
    if (!app.isReady()) {
      throw new Error(
        "createTextureBridge()/createTextureBridgeWith() must be called after app.whenReady()",
      );
    }

    const { name, width, height, frameRate = 60, rendererUrl, preview } = options;

    const policy = resolveOsrScalePolicy(resolveElectronMajor(process.versions));

    // ---- Offscreen BrowserWindow ----
    // Window DIP size per the OSR scale policy: under unit-scale DIP == px so the
    // requested size passes through; under device-scale (Electron ≤ 40) pixelExact
    // pre-divides by the primary display's scaleFactor. The sender below always
    // uses pixel-space dimensions.
    const dip = resolveWindowDipSize(options, policy, screen.getPrimaryDisplay().scaleFactor);
    const renderWindow = deps.createWindow(
      buildBrowserWindowOptions({ ...options, ...dip }, policy),
    );

    // ---- Native sender ----
    const sender = deps.createSender(name, width, height);

    // ---- Preview ----
    const previewManager =
      preview && preview.enabled !== false ? new PreviewManager(width, height, preview) : null;
    previewManager?.open();

    // ---- Bridge instance ----
    const bridge = new TextureBridgeImpl(
      renderWindow,
      sender,
      previewManager,
      options,
      policy,
      deps.createSender,
    );

    // ---- Paint handler (delegates to instance method, no private field access) ----
    renderWindow.webContents.on("paint", (event: PaintEvent) => {
      bridge.handlePaint(event);
    });

    renderWindow.webContents.setFrameRate(frameRate);

    // ---- Load renderer URL ----
    const isUrlScheme =
      rendererUrl.startsWith("http://") ||
      rendererUrl.startsWith("https://") ||
      rendererUrl.startsWith("file://");
    if (isUrlScheme) {
      await renderWindow.loadURL(rendererUrl);
    } else {
      await renderWindow.loadFile(rendererUrl);
    }

    bridge.emit("ready");

    return bridge;
  };

/**
 * {@link createTextureBridgeWith} bound to the real BrowserWindow / TextureSender.
 * Must be called after `app.whenReady()`.
 */
export const createTextureBridge = createTextureBridgeWith({
  createWindow: (options) => new BrowserWindow(options),
  createSender: (name, width, height) => new TextureSender(name, width, height),
});
