import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock Electron and the native core so we can import bridge.ts in node tests.
// `buildBrowserWindowOptions` is a pure function, but the module-level
// `import { app, BrowserWindow } from "electron"` would otherwise pull the
// real native module.
const getPrimaryDisplayMock = vi.fn(() => ({ scaleFactor: 1 }));

// Captures every `new BrowserWindow(options)` call made by `createTextureBridge`
// so tests can assert on the constructed window options without a real
// native module. Existing tests construct `new BrowserWindow()` with no
// args, so the `options !== undefined` guard keeps those unaffected.
const constructedWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];

vi.mock("electron", () => ({
  app: { isReady: () => true },
  BrowserWindow: class MockBrowserWindow {
    setSize = vi.fn();
    webContents = { on: vi.fn(), setFrameRate: vi.fn() };
    loadURL = vi.fn(async () => undefined);
    loadFile = vi.fn(async () => undefined);
    constructor(options?: Electron.BrowserWindowConstructorOptions) {
      if (options !== undefined) constructedWindowOptions.push(options);
    }
    isDestroyed(): boolean {
      return false;
    }
    close = vi.fn();
    destroy = vi.fn();
  },
  screen: {
    getPrimaryDisplay: () => getPrimaryDisplayMock(),
  },
}));

// Lets resize-rollback tests force the sender constructor to throw exactly N
// times without a `let` rebinding — a plain mutable holder object instead.
// Counting (rather than a boolean) lets the *forward* construction throw
// while the *rollback* reconstruction succeeds, so the rollback path is
// genuinely exercised rather than short-circuited by a second throw.
const senderCtorBehavior = { throwsRemaining: 0 };

// Records every `new TextureSender(name, width, height)` call so tests can
// assert the sender is always constructed in pixel space, under both OSR
// scale policies — a regression passing DIP sizes here would otherwise be
// invisible since MockTextureSender previously ignored its ctor args.
const senderCtorArgs: Array<readonly [string, number, number]> = [];

vi.mock("@napolab/texture-bridge-core", () => ({
  TextureSender: class MockTextureSender {
    constructor(name?: string, width?: number, height?: number) {
      if (senderCtorBehavior.throwsRemaining > 0) {
        senderCtorBehavior.throwsRemaining -= 1;
        throw new Error("sender ctor failed");
      }
      if (name !== undefined) senderCtorArgs.push([name, width ?? 0, height ?? 0]);
    }
    stop = vi.fn();
  },
  sendTextureFromPaintEvent: vi.fn(),
}));

const forwardSharedTextureMock = vi.fn(
  async (..._args: unknown[]): Promise<ForwardDefect | undefined> => undefined,
);
vi.mock("@napolab/texture-bridge-core/electron", () => ({
  forwardSharedTexture: (...args: unknown[]) => forwardSharedTextureMock(...args),
}));

import {
  buildBrowserWindowOptions,
  computeDipSize,
  createTextureBridge,
  createTextureBridgeWith,
  resolveElectronMajor,
  resolveOsrScalePolicy,
  resolveWindowDipSize,
  TextureBridgeImpl,
} from "../bridge";
import { BrowserWindow } from "electron";
import { TextureSender, sendTextureFromPaintEvent } from "@napolab/texture-bridge-core";
import type { PaintDefect, PaintTexture } from "@napolab/texture-bridge-core";
import type { ForwardDefect } from "@napolab/texture-bridge-core/electron";
import type { ForwardStatus, ForwardStatusEvent, TextureBridgeOptions } from "../types";
import type { PreviewManager } from "../preview-manager";

// Module-scope so both `TextureBridgeImpl.handlePaint — frameDropped` and
// `TextureBridgeImpl.forwardFrames` describe blocks can drive the same mock.
const sendMock = vi.mocked(sendTextureFromPaintEvent);

afterEach(() => {
  getPrimaryDisplayMock.mockReturnValue({ scaleFactor: 1 });
  senderCtorBehavior.throwsRemaining = 0;
  senderCtorArgs.length = 0;
  forwardSharedTextureMock.mockClear();
  // sendMock is module-scope (see above) — reset it here too, so a leftover
  // mockReturnValue/mockImplementation from one describe block cannot leak
  // into the next. The forwardFrames describe block being last in the file
  // is currently incidental, not guaranteed.
  sendMock.mockReset();
});

const baseOpts: TextureBridgeOptions = {
  name: "test",
  width: 1920,
  height: 1080,
  rendererUrl: "file:///renderer.html",
};

describe("buildBrowserWindowOptions", () => {
  it("forwards width and height to the BrowserWindow constructor args", () => {
    const out = buildBrowserWindowOptions(
      { ...baseOpts, width: 1280, height: 720 },
      "device-scale",
    );
    expect(out.width).toBe(1280);
    expect(out.height).toBe(720);
  });

  it("creates a hidden offscreen window with sharedTexture by default", () => {
    const out = buildBrowserWindowOptions(baseOpts, "device-scale");
    expect(out.show).toBe(false);
    expect(out.webPreferences?.contextIsolation).toBe(true);
    expect(out.webPreferences?.nodeIntegration).toBe(false);
    // `offscreen.useSharedTexture` is the contract Electron 40+ requires
    // for the GPU zero-copy paint event path.
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true });
  });

  it("does not enable transparent by default", () => {
    const out = buildBrowserWindowOptions(baseOpts, "device-scale");
    expect(out.transparent).toBeUndefined();
    expect(out.backgroundColor).toBeUndefined();
  });

  it("sets transparent + alpha-zero backgroundColor when includeAlpha: true", () => {
    // The compositor only emits per-pixel alpha into the OSR shared texture
    // when both flags are set on the BrowserWindow. transparent:true alone
    // leaves Chromium painting an opaque backdrop; backgroundColor with the
    // alpha byte zero is what flips the initial fill to fully-transparent.
    const out = buildBrowserWindowOptions({ ...baseOpts, includeAlpha: true }, "device-scale");
    expect(out.transparent).toBe(true);
    expect(out.backgroundColor).toBe("#00000000");
  });

  it("treats includeAlpha: false the same as omitted", () => {
    const out = buildBrowserWindowOptions({ ...baseOpts, includeAlpha: false }, "device-scale");
    expect(out.transparent).toBeUndefined();
    expect(out.backgroundColor).toBeUndefined();
  });

  it("preserves caller-supplied webPreferences (merge over the offscreen base)", () => {
    const out = buildBrowserWindowOptions(
      {
        ...baseOpts,
        webPreferences: { backgroundThrottling: false },
      },
      "device-scale",
    );
    expect(out.webPreferences?.backgroundThrottling).toBe(false);
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true });
  });

  it("lets caller-supplied webPreferences override the base defaults", () => {
    // Documents the existing override behavior in createTextureBridge so we
    // do not silently regress when refactoring the helper.
    const out = buildBrowserWindowOptions(
      {
        ...baseOpts,
        webPreferences: { contextIsolation: false },
      },
      "device-scale",
    );
    expect(out.webPreferences?.contextIsolation).toBe(false);
  });

  it("does not set enableLargerThanScreen by default", () => {
    const out = buildBrowserWindowOptions(baseOpts, "device-scale");
    expect(out.enableLargerThanScreen).toBeUndefined();
  });

  it("sets enableLargerThanScreen when pixelExact: true", () => {
    // `enableLargerThanScreen` is the documented escape hatch for letting
    // an offscreen BrowserWindow render at a DIP size that may exceed the
    // host display's work area. This is required when the caller has
    // pre-translated a large pixel target into DIP via `computeDipSize`
    // and the resulting DIP is still larger than the display's available
    // area (rare, but possible on small / low-DPR monitors).
    const out = buildBrowserWindowOptions({ ...baseOpts, pixelExact: true }, "device-scale");
    expect(out.enableLargerThanScreen).toBe(true);
  });

  it("treats pixelExact: false the same as omitted", () => {
    const out = buildBrowserWindowOptions({ ...baseOpts, pixelExact: false }, "device-scale");
    expect(out.enableLargerThanScreen).toBeUndefined();
  });
});

describe("buildBrowserWindowOptions — OSR scale policy", () => {
  it("pins offscreen.deviceScaleFactor to 1 under unit-scale", () => {
    const out = buildBrowserWindowOptions(baseOpts, "unit-scale");
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true, deviceScaleFactor: 1 });
  });

  it("does not set deviceScaleFactor under device-scale", () => {
    const out = buildBrowserWindowOptions(baseOpts, "device-scale");
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true });
  });

  it("always enables enableLargerThanScreen under unit-scale", () => {
    const out = buildBrowserWindowOptions(baseOpts, "unit-scale");
    expect(out.enableLargerThanScreen).toBe(true);
  });

  it("keeps enableLargerThanScreen gated on pixelExact under device-scale", () => {
    expect(
      buildBrowserWindowOptions(baseOpts, "device-scale").enableLargerThanScreen,
    ).toBeUndefined();
    expect(
      buildBrowserWindowOptions({ ...baseOpts, pixelExact: true }, "device-scale")
        .enableLargerThanScreen,
    ).toBe(true);
  });

  it("lets a user-supplied webPreferences.offscreen win entirely", () => {
    // `deviceScaleFactor` was added to Electron's `Offscreen` type in 41; the
    // workspace's installed Electron types are 40.x, so a fresh object
    // literal directly in the `offscreen` position would fail the excess
    // property check (TS2353) even though it is a valid runtime value on
    // Electron >= 41. Binding it to a named const first sidesteps the
    // literal-only excess property check without weakening the assertion.
    const userOffscreen = { useSharedTexture: true, deviceScaleFactor: 2 };
    const out = buildBrowserWindowOptions(
      {
        ...baseOpts,
        webPreferences: { offscreen: userOffscreen },
      },
      "unit-scale",
    );
    expect(out.webPreferences?.offscreen).toEqual({ useSharedTexture: true, deviceScaleFactor: 2 });
  });
});

describe("computeDipSize", () => {
  it("returns the input unchanged when scaleFactor is 1", () => {
    expect(computeDipSize(1920, 1080, 1)).toEqual({ width: 1920, height: 1080 });
  });

  it("halves the input at scaleFactor 2 (e.g., macOS Retina)", () => {
    expect(computeDipSize(1920, 1080, 2)).toEqual({ width: 960, height: 540 });
  });

  it("rounds to the nearest integer for non-divisible ratios", () => {
    // 1920 / 1.75 = 1097.142857... → round to 1097
    // 1080 / 1.75 =  617.142857... → round to 617
    // Chromium typically computes framebuffer = round(DIP × scaleFactor),
    // so 1097 × 1.75 = 1919.75 → 1920 px, which matches the requested target.
    expect(computeDipSize(1920, 1080, 1.75)).toEqual({ width: 1097, height: 617 });
  });

  it("handles fractional scaleFactor 1.5 with no rounding loss", () => {
    // 1920 / 1.5 = 1280 exactly; 1080 / 1.5 = 720 exactly.
    expect(computeDipSize(1920, 1080, 1.5)).toEqual({ width: 1280, height: 720 });
  });

  it("clamps minimum DIP to 1 to prevent zero-sized windows", () => {
    // A 4 × 4 pixel target on a hypothetical 5x display would round to 0
    // without the floor — passing 0 to BrowserWindow's width/height would
    // trigger a runtime error rather than silently producing a usable
    // window.
    expect(computeDipSize(4, 4, 5)).toEqual({ width: 1, height: 1 });
  });

  it("falls back to pixel size when scaleFactor is zero or negative", () => {
    // Defensive — Electron should never return a non-positive scaleFactor
    // from `screen.getPrimaryDisplay()`, but division by zero would produce
    // Infinity and crash the BrowserWindow constructor.
    expect(computeDipSize(1920, 1080, 0)).toEqual({ width: 1920, height: 1080 });
    expect(computeDipSize(1920, 1080, -1)).toEqual({ width: 1920, height: 1080 });
  });
});

describe("TextureBridgeImpl.handlePaint — frameDropped", () => {
  const makeBridge = () =>
    new TextureBridgeImpl(new BrowserWindow(), new TextureSender("t", 16, 9), null, baseOpts);

  const makeTexture = () => ({
    textureInfo: {
      pixelFormat: "bgra" as const,
      codedSize: { width: 16, height: 9 },
      visibleRect: { x: 0, y: 0, width: 16, height: 9 },
      handle: {},
    },
    release: vi.fn(),
  });

  const collectDropped = (bridge: TextureBridgeImpl) => {
    const dropped: PaintDefect[] = [];
    bridge.on("frameDropped", (defect) => {
      dropped.push(defect);
    });
    return dropped;
  };

  it("emits a no-texture defect when the paint event has no texture", () => {
    sendMock.mockReset();
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);

    bridge.handlePaint({ texture: undefined });

    expect(dropped).toEqual([{ reason: "no-texture" }]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("emits the defect returned by sendTextureFromPaintEvent and still releases the texture", () => {
    sendMock.mockReset();
    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);
    const texture = makeTexture();

    bridge.handlePaint({ texture });

    expect(dropped).toEqual([{ reason: "no-nt-handle" }]);
    expect(texture.release).toHaveBeenCalledTimes(1);
  });

  it("dedupes consecutive defects with the same reason", () => {
    sendMock.mockReset();
    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);

    bridge.handlePaint({ texture: makeTexture() });
    bridge.handlePaint({ texture: makeTexture() });
    bridge.handlePaint({ texture: makeTexture() });

    expect(dropped).toEqual([{ reason: "no-nt-handle" }]);
  });

  it("re-emits after a successful send resets the dedupe state", () => {
    sendMock.mockReset();
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);

    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    bridge.handlePaint({ texture: makeTexture() });

    sendMock.mockReturnValue(undefined);
    bridge.handlePaint({ texture: makeTexture() });

    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    bridge.handlePaint({ texture: makeTexture() });

    expect(dropped).toEqual([{ reason: "no-nt-handle" }, { reason: "no-nt-handle" }]);
  });

  it("emits immediately when the defect reason changes", () => {
    sendMock.mockReset();
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);

    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    bridge.handlePaint({ texture: makeTexture() });

    sendMock.mockReturnValue({ reason: "no-io-surface" });
    bridge.handlePaint({ texture: makeTexture() });

    expect(dropped).toEqual([{ reason: "no-nt-handle" }, { reason: "no-io-surface" }]);
  });

  it("does not emit frameDropped on a successful send", () => {
    sendMock.mockReset();
    sendMock.mockReturnValue(undefined);
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);
    const texture = makeTexture();

    bridge.handlePaint({ texture });

    expect(dropped).toEqual([]);
    expect(texture.release).toHaveBeenCalledTimes(1);
  });

  it("exposes the latched drop reason via droppedReason", () => {
    sendMock.mockReset();
    const bridge = makeBridge();
    expect(bridge.droppedReason).toBeNull();

    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    bridge.handlePaint({ texture: makeTexture() });
    expect(bridge.droppedReason).toBe("no-nt-handle");

    sendMock.mockReturnValue(undefined);
    bridge.handlePaint({ texture: makeTexture() });
    expect(bridge.droppedReason).toBeNull();
  });

  it("releases a texture that arrives without textureInfo", () => {
    sendMock.mockReset();
    const bridge = makeBridge();
    const dropped = collectDropped(bridge);
    const release = vi.fn();
    // The runtime guard exists precisely because Electron can deliver a
    // texture without textureInfo — a state PaintTexture's type cannot
    // express, hence the two-step cast.
    const defective: unknown = { release };
    bridge.handlePaint({ texture: defective as PaintTexture });

    expect(release).toHaveBeenCalledTimes(1);
    expect(dropped).toEqual([{ reason: "no-texture" }]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("drops a post-dispose paint without emitting frameDropped or mutating droppedReason", () => {
    // Once disposed, the underlying sender has been stopped — calling into it
    // would throw for every in-flight paint. The guard must run before the
    // no-texture branch too, since a post-dispose paint can still arrive
    // without a texture and would otherwise latch a spurious drop reason.
    sendMock.mockReset();
    const bridge = makeBridge();
    bridge.dispose();
    // Attach the listener after dispose() — dispose() calls
    // removeAllListeners(), so a listener added beforehand would not observe
    // any (incorrect) emission and the assertion would be a false negative.
    const dropped = collectDropped(bridge);
    const texture = makeTexture();

    bridge.handlePaint({ texture });

    expect(dropped).toEqual([]);
    expect(bridge.droppedReason).toBeNull();
    expect(texture.release).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("still forwards the frame to the preview manager on a defect", () => {
    sendMock.mockReset();
    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    const sendFrame = vi.fn();
    // PreviewManager has private fields, so a structural stub cannot satisfy
    // its class type — the two-step cast injects the test double.
    const previewStub: unknown = { sendFrame };
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      new TextureSender("t", 16, 9),
      previewStub as PreviewManager,
      baseOpts,
    );
    const texture = makeTexture();

    bridge.handlePaint({ texture });

    expect(sendFrame).toHaveBeenCalledTimes(1);
    expect(sendFrame).toHaveBeenCalledWith(texture);
  });
});

describe("resolveElectronMajor", () => {
  it("parses the major version from a semver string", () => {
    expect(resolveElectronMajor({ electron: "42.4.0" })).toBe(42);
    expect(resolveElectronMajor({ electron: "40.2.1" })).toBe(40);
  });

  it("returns 0 when the electron version is missing or malformed", () => {
    expect(resolveElectronMajor({})).toBe(0);
    expect(resolveElectronMajor({ electron: "garbage" })).toBe(0);
  });
});

describe("resolveOsrScalePolicy", () => {
  it("selects device-scale for Electron 40 and below", () => {
    expect(resolveOsrScalePolicy(40)).toBe("device-scale");
    expect(resolveOsrScalePolicy(0)).toBe("device-scale");
  });

  it("selects unit-scale for Electron 41 and above", () => {
    expect(resolveOsrScalePolicy(41)).toBe("unit-scale");
    expect(resolveOsrScalePolicy(42)).toBe("unit-scale");
  });
});

describe("resolveWindowDipSize", () => {
  it("returns width/height untouched under unit-scale, even with pixelExact", () => {
    const size = resolveWindowDipSize(
      { width: 1920, height: 1080, pixelExact: true },
      "unit-scale",
      2,
    );
    expect(size).toEqual({ width: 1920, height: 1080 });
  });

  it("divides by scaleFactor under device-scale when pixelExact is set", () => {
    const size = resolveWindowDipSize(
      { width: 1920, height: 1080, pixelExact: true },
      "device-scale",
      2,
    );
    expect(size).toEqual({ width: 960, height: 540 });
  });

  it("returns width/height untouched under device-scale without pixelExact", () => {
    const size = resolveWindowDipSize({ width: 1920, height: 1080 }, "device-scale", 2);
    expect(size).toEqual({ width: 1920, height: 1080 });
  });
});

describe("TextureBridgeImpl.resize — OSR scale policy", () => {
  const makeBridgeWithPolicy = (
    policy: "device-scale" | "unit-scale",
    opts: TextureBridgeOptions,
  ) =>
    new TextureBridgeImpl(new BrowserWindow(), new TextureSender("t", 16, 9), null, opts, policy);

  it("sets the window to the raw pixel size under unit-scale even with pixelExact", () => {
    getPrimaryDisplayMock.mockReturnValue({ scaleFactor: 2 });
    const bridge = makeBridgeWithPolicy("unit-scale", { ...baseOpts, pixelExact: true });

    bridge.resize(1280, 720);

    expect(bridge.renderWindow.setSize).toHaveBeenCalledWith(1280, 720);
    expect(senderCtorArgs.at(-1)).toEqual(["test", 1280, 720]);
  });

  it("divides the window size by scaleFactor under device-scale with pixelExact", () => {
    getPrimaryDisplayMock.mockReturnValue({ scaleFactor: 2 });
    const bridge = makeBridgeWithPolicy("device-scale", { ...baseOpts, pixelExact: true });

    bridge.resize(1280, 720);

    expect(bridge.renderWindow.setSize).toHaveBeenCalledWith(640, 360);
    expect(senderCtorArgs.at(-1)).toEqual(["test", 1280, 720]);
  });

  it("rolls the window size back when the new sender cannot be constructed", () => {
    getPrimaryDisplayMock.mockReturnValue({ scaleFactor: 2 });
    const win = new BrowserWindow();
    const bridge = new TextureBridgeImpl(
      win,
      new TextureSender("t", 16, 9),
      null,
      { ...baseOpts, pixelExact: true },
      "device-scale",
    );

    // Exactly one throw: the *forward* `new TextureSender(...)` fails, the
    // *rollback* reconstruction inside the catch block must succeed — so the
    // final `throw err` genuinely rethrows the original forward error rather
    // than short-circuiting on a second throw from the rollback itself.
    senderCtorBehavior.throwsRemaining = 1;
    expect(() => bridge.resize(1280, 720)).toThrow("sender ctor failed");
    expect(senderCtorBehavior.throwsRemaining).toBe(0);

    expect(vi.mocked(win.setSize).mock.calls).toEqual([
      [640, 360], // forward: 1280x720 / scaleFactor 2
      [960, 540], // rollback: baseOpts 1920x1080 / scaleFactor 2
    ]);

    // The rolled-back sender is functional: a subsequent resize succeeds.
    expect(() => bridge.resize(1024, 512)).not.toThrow();
  });
});

describe("createTextureBridge — OSR scale policy wiring", () => {
  const withElectronMajor = async (version: string, run: () => Promise<void>): Promise<void> => {
    const original = Object.getOwnPropertyDescriptor(process.versions, "electron");
    Object.defineProperty(process.versions, "electron", { value: version, configurable: true });
    try {
      await run();
    } finally {
      if (original) Object.defineProperty(process.versions, "electron", original);
      else Reflect.deleteProperty(process.versions, "electron");
    }
  };

  it("builds the window at raw pixel size with deviceScaleFactor pinned on Electron >= 41", async () => {
    await withElectronMajor("42.0.0", async () => {
      getPrimaryDisplayMock.mockReturnValue({ scaleFactor: 2 });
      constructedWindowOptions.length = 0;

      const bridge = await createTextureBridge({ ...baseOpts, pixelExact: true });

      const [windowOptions] = constructedWindowOptions;
      expect(windowOptions?.width).toBe(1920);
      expect(windowOptions?.height).toBe(1080);
      expect(windowOptions?.enableLargerThanScreen).toBe(true);
      expect(windowOptions?.webPreferences?.offscreen).toEqual({
        useSharedTexture: true,
        deviceScaleFactor: 1,
      });
      expect(senderCtorArgs).toContainEqual(["test", 1920, 1080]);

      // policy handoff to the impl: resize under unit-scale ignores pixelExact
      bridge.resize(1280, 720);
      expect(bridge.renderWindow.setSize).toHaveBeenCalledWith(1280, 720);
    });
  });

  it("keeps legacy DIP division on Electron 40", async () => {
    await withElectronMajor("40.2.1", async () => {
      getPrimaryDisplayMock.mockReturnValue({ scaleFactor: 2 });
      constructedWindowOptions.length = 0;

      await createTextureBridge({ ...baseOpts, pixelExact: true });

      const [windowOptions] = constructedWindowOptions;
      expect(windowOptions?.width).toBe(960);
      expect(windowOptions?.height).toBe(540);
      expect(windowOptions?.webPreferences?.offscreen).toEqual({ useSharedTexture: true });
      expect(senderCtorArgs).toContainEqual(["test", 1920, 1080]);
    });
  });
});

describe("createTextureBridgeWith — dependency injection seam", () => {
  it("routes window and sender construction through the injected deps", async () => {
    const createWindow = vi.fn(
      (options: Electron.BrowserWindowConstructorOptions) => new BrowserWindow(options),
    );
    const createSender = vi.fn(
      (name: string, width: number, height: number) => new TextureSender(name, width, height),
    );

    const bridge = await createTextureBridgeWith({ createWindow, createSender })(baseOpts);

    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(createWindow.mock.calls[0]?.[0]?.webPreferences?.offscreen).toBeDefined();
    expect(createSender).toHaveBeenCalledWith("test", 1920, 1080);

    bridge.resize(1280, 720);
    expect(createSender).toHaveBeenCalledWith("test", 1280, 720);
  });

  it("routes the resize rollback reconstruction through the injected createSender", async () => {
    const createWindow = vi.fn(
      (options: Electron.BrowserWindowConstructorOptions) => new BrowserWindow(options),
    );
    const createSender = vi.fn(
      (name: string, width: number, height: number) => new TextureSender(name, width, height),
    );
    const bridge = await createTextureBridgeWith({ createWindow, createSender })(baseOpts);
    createSender.mockClear();

    senderCtorBehavior.throwsRemaining = 1;
    expect(() => bridge.resize(1280, 720)).toThrow("sender ctor failed");

    expect(createSender).toHaveBeenCalledTimes(2);
    expect(createSender).toHaveBeenNthCalledWith(1, "test", 1280, 720);
    expect(createSender).toHaveBeenNthCalledWith(2, "test", 1920, 1080);
  });
});

describe("TextureBridgeImpl.dispose — synchronous teardown", () => {
  it("destroys the render window synchronously instead of close()", () => {
    const win = new BrowserWindow();
    const bridge = new TextureBridgeImpl(win, new TextureSender("t", 16, 9), null, baseOpts);

    bridge.dispose();

    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(win.close).not.toHaveBeenCalled();
    expect(bridge.isDisposed).toBe(true);
  });

  it("is idempotent", () => {
    const win = new BrowserWindow();
    const bridge = new TextureBridgeImpl(win, new TextureSender("t", 16, 9), null, baseOpts);

    bridge.dispose();
    bridge.dispose();

    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps the teardown order: destroy window → stop sender → dispose preview → emit disposed", () => {
    const win = new BrowserWindow();
    const sender = new TextureSender("t", 16, 9);
    const previewDispose = vi.fn();
    const previewStub: unknown = { dispose: previewDispose };
    const bridge = new TextureBridgeImpl(win, sender, previewStub as PreviewManager, baseOpts);
    const disposedListener = vi.fn();
    bridge.on("disposed", disposedListener);

    bridge.dispose();

    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(sender.stop).toHaveBeenCalledTimes(1);
    expect(previewDispose).toHaveBeenCalledTimes(1);
    expect(disposedListener).toHaveBeenCalledTimes(1);
    const order = [
      vi.mocked(win.destroy).mock.invocationCallOrder[0],
      vi.mocked(sender.stop).mock.invocationCallOrder[0],
      previewDispose.mock.invocationCallOrder[0],
      disposedListener.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(order);
  });
});

describe("TextureBridgeImpl.forwardFrames", () => {
  const makeTexture = () => ({
    textureInfo: {
      pixelFormat: "bgra" as const,
      codedSize: { width: 16, height: 9 },
      visibleRect: { x: 0, y: 0, width: 16, height: 9 },
      handle: {},
    },
    release: vi.fn(),
  });

  // WebContents はクラス型かつ EventEmitter を継承するため、構造スタブは
  // two-step cast で注入(確立パターン)。forwardFrames が "destroyed" を
  // once() で購読するようになったため(F14 pruning)、プレーンオブジェクトの
  // 構造スタブでは足りず実 EventEmitter を土台にする。
  const makeWebContentsStub = (id: string): Electron.WebContents => {
    // forwardFrames() calls target.isDestroyed() at registration time (N3
    // guard) in addition to relying on the "destroyed" event, so the stub
    // needs a default (alive) isDestroyed — individual tests override it
    // via Object.assign when they need an already-destroyed target.
    const stub: unknown = Object.assign(new EventEmitter(), { id, isDestroyed: () => false });
    return stub as Electron.WebContents;
  };

  it("forwards each paint frame to every registered target with its extraArgs", () => {
    sendMock.mockReturnValue(undefined);
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      new TextureSender("t", 16, 9),
      null,
      baseOpts,
    );
    const wcA = makeWebContentsStub("a");
    const wcB = makeWebContentsStub("b");
    bridge.forwardFrames(wcA, { extraArgs: [0] });
    bridge.forwardFrames(wcB, { extraArgs: [1] });

    const texture = makeTexture();
    bridge.handlePaint({ texture });

    expect(forwardSharedTextureMock).toHaveBeenCalledTimes(2);
    expect(forwardSharedTextureMock).toHaveBeenCalledWith(texture.textureInfo, wcA, [0]);
    expect(forwardSharedTextureMock).toHaveBeenCalledWith(texture.textureInfo, wcB, [1]);
  });

  it("stops forwarding after FrameForward.dispose(), idempotently", () => {
    sendMock.mockReturnValue(undefined);
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      new TextureSender("t", 16, 9),
      null,
      baseOpts,
    );
    const wc = makeWebContentsStub("a");
    const forward = bridge.forwardFrames(wc);
    forward.dispose();
    forward.dispose();

    bridge.handlePaint({ texture: makeTexture() });
    expect(forwardSharedTextureMock).not.toHaveBeenCalled();
  });

  it("defaults extraArgs to [] and keeps forwarding on defect results (best-effort)", async () => {
    sendMock.mockReturnValue(undefined);
    forwardSharedTextureMock.mockResolvedValueOnce({
      reason: "send-failed",
      cause: new Error("x"),
    });
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      new TextureSender("t", 16, 9),
      null,
      baseOpts,
    );
    const wc = makeWebContentsStub("a");
    bridge.forwardFrames(wc);
    const errors: Error[] = [];
    bridge.on("error", (e) => {
      errors.push(e);
    });

    bridge.handlePaint({ texture: makeTexture() });
    bridge.handlePaint({ texture: makeTexture() });
    await Promise.resolve();

    expect(forwardSharedTextureMock).toHaveBeenCalledTimes(2);
    expect(forwardSharedTextureMock).toHaveBeenNthCalledWith(1, expect.anything(), wc, []);
    expect(errors).toEqual([]); // defect は error イベントを汚さない
  });

  it("stops all forwards when the bridge is disposed", () => {
    sendMock.mockReturnValue(undefined);
    const win = new BrowserWindow();
    const bridge = new TextureBridgeImpl(win, new TextureSender("t", 16, 9), null, baseOpts);
    const wc = makeWebContentsStub("a");
    bridge.forwardFrames(wc);
    bridge.dispose();

    bridge.handlePaint({ texture: makeTexture() });
    expect(forwardSharedTextureMock).not.toHaveBeenCalled();
  });

  it("still forwards when the Syphon send returns a defect", () => {
    sendMock.mockReturnValue({ reason: "no-nt-handle" });
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      new TextureSender("t", 16, 9),
      null,
      baseOpts,
    );
    const wc = makeWebContentsStub("a");
    bridge.forwardFrames(wc);

    bridge.handlePaint({ texture: makeTexture() });

    expect(forwardSharedTextureMock).toHaveBeenCalledTimes(1);
  });

  it("still forwards when the native send throws", () => {
    sendMock.mockImplementation(() => {
      throw new Error("TextureSender has been stopped");
    });
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      new TextureSender("t", 16, 9),
      null,
      baseOpts,
    );
    const wc = makeWebContentsStub("a");
    bridge.forwardFrames(wc);
    const errors: Error[] = [];
    bridge.on("error", (e) => {
      errors.push(e);
    });

    bridge.handlePaint({ texture: makeTexture() });

    expect(forwardSharedTextureMock).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });

  it("returns an inert handle and does not register when the bridge is already disposed (F5)", () => {
    sendMock.mockReturnValue(undefined);
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      new TextureSender("t", 16, 9),
      null,
      baseOpts,
    );
    bridge.dispose();
    const wc = makeWebContentsStub("a");

    const forward = bridge.forwardFrames(wc);

    // Retention is unobservable from behavior alone (handlePaint also
    // disposed-guards, so an inert registration and a genuinely-skipped one
    // look identical from outside) — white-box assert directly on the
    // internal Set (established two-step-cast pattern for private-field
    // inspection in this file). Checked BEFORE calling forward.dispose() —
    // disposing the returned handle would remove any wrongly-added entry
    // itself and mask a missing guard.
    const forwardEntries = (bridge as unknown as { forwardEntries: Set<unknown> }).forwardEntries;
    expect(forwardEntries.size).toBe(0);

    bridge.handlePaint({ texture: makeTexture() });
    expect(forwardSharedTextureMock).not.toHaveBeenCalled();

    expect(() => forward.dispose()).not.toThrow();
  });

  it("clears forwardEntries on dispose (F5, white-box)", () => {
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      new TextureSender("t", 16, 9),
      null,
      baseOpts,
    );
    bridge.forwardFrames(makeWebContentsStub("a"));
    bridge.forwardFrames(makeWebContentsStub("b"));

    const forwardEntries = (bridge as unknown as { forwardEntries: Set<unknown> }).forwardEntries;
    expect(forwardEntries.size).toBe(2);

    bridge.dispose();

    expect(forwardEntries.size).toBe(0);
  });

  it("prunes the entry when the target WebContents emits destroyed (F14)", () => {
    sendMock.mockReturnValue(undefined);
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      new TextureSender("t", 16, 9),
      null,
      baseOpts,
    );
    const wc = makeWebContentsStub("a");
    bridge.forwardFrames(wc);

    wc.emit("destroyed");

    bridge.handlePaint({ texture: makeTexture() });
    expect(forwardSharedTextureMock).not.toHaveBeenCalled();
  });

  it("does not leave a dangling destroyed listener after dispose() (F14)", () => {
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      new TextureSender("t", 16, 9),
      null,
      baseOpts,
    );
    const wc = makeWebContentsStub("a");
    const forward = bridge.forwardFrames(wc);

    expect(wc.listenerCount("destroyed")).toBe(1);

    forward.dispose();

    expect(wc.listenerCount("destroyed")).toBe(0);
  });

  it("unhooks every entry's destroyed listener on bridge.dispose() (N1)", () => {
    // Bug class F14 fixed via FrameForward.dispose() — bridge.dispose()
    // itself only cleared forwardEntries without unhooking, so a listener
    // stayed registered on a caller-owned, possibly long-lived target
    // (e.g. the multiviewer window) after the bridge that registered it was
    // gone. Enough create/dispose cycles against the same target without
    // this trip MaxListenersExceededWarning.
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      new TextureSender("t", 16, 9),
      null,
      baseOpts,
    );
    const wcA = makeWebContentsStub("a");
    const wcB = makeWebContentsStub("b");
    bridge.forwardFrames(wcA);
    bridge.forwardFrames(wcB);

    expect(wcA.listenerCount("destroyed")).toBe(1);
    expect(wcB.listenerCount("destroyed")).toBe(1);

    bridge.dispose();

    expect(wcA.listenerCount("destroyed")).toBe(0);
    expect(wcB.listenerCount("destroyed")).toBe(0);
  });

  it("does not throw when disposing with an entry whose target is already destroyed (N1)", () => {
    // removeListener can throw once the underlying WebContents itself has
    // been destroyed — bridge.dispose() must guard against that instead of
    // assuming every registered target is still alive.
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      new TextureSender("t", 16, 9),
      null,
      baseOpts,
    );
    const wc = makeWebContentsStub("a");
    bridge.forwardFrames(wc);
    Object.assign(wc, { isDestroyed: () => true });

    expect(() => bridge.dispose()).not.toThrow();
  });

  it("returns an inert handle and does not register against an already-destroyed target (N3)", () => {
    sendMock.mockReturnValue(undefined);
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      new TextureSender("t", 16, 9),
      null,
      baseOpts,
    );
    const wc = makeWebContentsStub("a");
    Object.assign(wc, { isDestroyed: () => true });

    const forward = bridge.forwardFrames(wc);

    // A "destroyed" listener registered against an already-destroyed
    // target would never fire — the entry would never self-prune. White-box
    // assert no registration happened at all (checked before calling
    // dispose(), same rationale as the F5 inert-handle test above).
    const forwardEntries = (bridge as unknown as { forwardEntries: Set<unknown> }).forwardEntries;
    expect(forwardEntries.size).toBe(0);
    expect(wc.listenerCount("destroyed")).toBe(0);

    bridge.handlePaint({ texture: makeTexture() });
    expect(forwardSharedTextureMock).not.toHaveBeenCalled();

    expect(() => forward.dispose()).not.toThrow();
  });
});

// forwardFrames の配信状態は 0.14 まで完全に不可視だった(defect は catch で捨てられ、
// 登録失敗は inert handle で黙殺)。本番で「paint は正常なのにプレビューだけ無言で死ぬ」
// 事故が起きても切り分ける手段が無かったため、状態遷移を 1 本のチャネルで出す。
describe("TextureBridgeImpl.forwardFrames — status observability", () => {
  const makeTexture = () => ({
    textureInfo: {
      pixelFormat: "bgra" as const,
      codedSize: { width: 16, height: 9 },
      visibleRect: { x: 0, y: 0, width: 16, height: 9 },
      handle: {},
    },
    release: vi.fn(),
  });

  const makeWebContentsStub = (id: string): Electron.WebContents => {
    const stub: unknown = Object.assign(new EventEmitter(), { id, isDestroyed: () => false });
    return stub as Electron.WebContents;
  };

  const makeBridge = (): TextureBridgeImpl =>
    new TextureBridgeImpl(new BrowserWindow(), new TextureSender("t", 16, 9), null, baseOpts);

  // forwardSharedTexture は async — 解決 → .then → emit まで複数 tick かかるので
  // マクロタスク境界まで待ってから assert する。
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("emits forwardStatus { ok: true } once when forwarding starts, not per frame", async () => {
    sendMock.mockReturnValue(undefined);
    const bridge = makeBridge();
    const statuses: ForwardStatusEvent[] = [];
    bridge.on("forwardStatus", (s) => {
      statuses.push(s);
    });
    bridge.forwardFrames(makeWebContentsStub("a"), { extraArgs: ["P1"] });

    bridge.handlePaint({ texture: makeTexture() });
    bridge.handlePaint({ texture: makeTexture() });
    await flush();

    expect(statuses).toEqual([{ ok: true, extraArgs: ["P1"] }]);
  });

  it("emits ok:false with the defect reason and dedupes consecutive identical failures", async () => {
    sendMock.mockReturnValue(undefined);
    // 永続 mockResolvedValue は afterEach の mockClear では消えず後続テストへ漏れるので
    // フレーム数ぶんの Once を積む。
    forwardSharedTextureMock
      .mockResolvedValueOnce({ reason: "target-destroyed" })
      .mockResolvedValueOnce({ reason: "target-destroyed" })
      .mockResolvedValueOnce({ reason: "target-destroyed" });
    const bridge = makeBridge();
    const statuses: ForwardStatusEvent[] = [];
    bridge.on("forwardStatus", (s) => {
      statuses.push(s);
    });
    bridge.forwardFrames(makeWebContentsStub("a"));

    bridge.handlePaint({ texture: makeTexture() });
    bridge.handlePaint({ texture: makeTexture() });
    bridge.handlePaint({ texture: makeTexture() });
    await flush();

    expect(statuses).toEqual([{ ok: false, reason: "target-destroyed", extraArgs: [] }]);
  });

  it("emits ok:true again when forwarding recovers", async () => {
    sendMock.mockReturnValue(undefined);
    forwardSharedTextureMock.mockResolvedValueOnce({ reason: "target-destroyed" });
    const bridge = makeBridge();
    const statuses: ForwardStatusEvent[] = [];
    bridge.on("forwardStatus", (s) => {
      statuses.push(s);
    });
    bridge.forwardFrames(makeWebContentsStub("a"));

    bridge.handlePaint({ texture: makeTexture() });
    await flush();
    bridge.handlePaint({ texture: makeTexture() });
    await flush();

    expect(statuses.map((s) => s.ok)).toEqual([false, true]);
  });

  it("emits again when the failure reason changes", async () => {
    sendMock.mockReturnValue(undefined);
    const cause = new Error("boom");
    forwardSharedTextureMock.mockResolvedValueOnce({ reason: "import-failed", cause });
    forwardSharedTextureMock.mockResolvedValueOnce({ reason: "send-failed", cause });
    const bridge = makeBridge();
    const statuses: ForwardStatusEvent[] = [];
    bridge.on("forwardStatus", (s) => {
      statuses.push(s);
    });
    bridge.forwardFrames(makeWebContentsStub("a"));

    bridge.handlePaint({ texture: makeTexture() });
    await flush();
    bridge.handlePaint({ texture: makeTexture() });
    await flush();

    expect(statuses).toEqual([
      { ok: false, reason: "import-failed", cause, extraArgs: [] },
      { ok: false, reason: "send-failed", cause, extraArgs: [] },
    ]);
  });

  it("treats a rejected forward as a send-failed status", async () => {
    sendMock.mockReturnValue(undefined);
    const cause = new Error("rejected");
    forwardSharedTextureMock.mockRejectedValueOnce(cause);
    const bridge = makeBridge();
    const statuses: ForwardStatusEvent[] = [];
    bridge.on("forwardStatus", (s) => {
      statuses.push(s);
    });
    bridge.forwardFrames(makeWebContentsStub("a"));

    bridge.handlePaint({ texture: makeTexture() });
    await flush();

    expect(statuses).toEqual([{ ok: false, reason: "send-failed", cause, extraArgs: [] }]);
  });

  it("invokes the per-forward onStatus callback with the same transitions", async () => {
    sendMock.mockReturnValue(undefined);
    forwardSharedTextureMock.mockResolvedValueOnce({ reason: "target-destroyed" });
    const bridge = makeBridge();
    const seen: ForwardStatus[] = [];
    bridge.forwardFrames(makeWebContentsStub("a"), {
      extraArgs: ["P1"],
      onStatus: (s) => {
        seen.push(s);
      },
    });

    bridge.handlePaint({ texture: makeTexture() });
    await flush();
    bridge.handlePaint({ texture: makeTexture() });
    await flush();

    expect(seen).toEqual([{ ok: false, reason: "target-destroyed" }, { ok: true }]);
  });

  it("keeps forwarding when an onStatus callback throws", async () => {
    sendMock.mockReturnValue(undefined);
    const bridge = makeBridge();
    bridge.forwardFrames(makeWebContentsStub("a"), {
      onStatus: () => {
        throw new Error("listener blew up");
      },
    });

    bridge.handlePaint({ texture: makeTexture() });
    await flush();
    bridge.handlePaint({ texture: makeTexture() });
    await flush();

    // 例外は unhandled rejection にならず、後続フレームの転送も止まらない。
    expect(forwardSharedTextureMock).toHaveBeenCalledTimes(2);
  });

  it("does not emit for a forward disposed while a frame was in flight", async () => {
    sendMock.mockReturnValue(undefined);
    let settle: (value: undefined) => void = () => {};
    forwardSharedTextureMock.mockImplementationOnce(
      async () =>
        await new Promise<undefined>((resolve) => {
          settle = resolve;
        }),
    );
    const bridge = makeBridge();
    const statuses: ForwardStatusEvent[] = [];
    bridge.on("forwardStatus", (s) => {
      statuses.push(s);
    });
    const forward = bridge.forwardFrames(makeWebContentsStub("a"));

    bridge.handlePaint({ texture: makeTexture() });
    forward.dispose();
    settle(undefined);
    await flush();

    expect(statuses).toEqual([]);
  });

  it("exposes active: true while registered and false once disposed", () => {
    sendMock.mockReturnValue(undefined);
    const bridge = makeBridge();
    const forward = bridge.forwardFrames(makeWebContentsStub("a"));

    expect(forward.active).toBe(true);

    forward.dispose();

    expect(forward.active).toBe(false);
  });

  it("flips active to false when the target is destroyed or the bridge is disposed", () => {
    sendMock.mockReturnValue(undefined);
    const bridge = makeBridge();
    const wc = makeWebContentsStub("a");
    const byTarget = bridge.forwardFrames(wc);
    const byBridge = bridge.forwardFrames(makeWebContentsStub("b"));

    wc.emit("destroyed");
    expect(byTarget.active).toBe(false);
    expect(byBridge.active).toBe(true);

    bridge.dispose();
    expect(byBridge.active).toBe(false);
  });

  it("reports active: false for a registration that was silently refused", () => {
    sendMock.mockReturnValue(undefined);
    const bridge = makeBridge();
    const dead = makeWebContentsStub("a");
    Object.assign(dead, { isDestroyed: () => true });

    // 破壊済み target と dispose 済み bridge — どちらも 0.14 では inert handle を
    // 無言で返していた。呼び出し側が登録の失敗を検知できることが肝。
    expect(bridge.forwardFrames(dead).active).toBe(false);

    bridge.dispose();

    expect(bridge.forwardFrames(makeWebContentsStub("b")).active).toBe(false);
  });
});
