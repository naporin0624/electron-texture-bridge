import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockFrame = {
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: string;
  readonly ownerPid: number;
  readonly handle: Buffer;
};

const mockReceiver = {
  receiveSharedTexture: vi.fn<() => MockFrame | null>().mockReturnValue(null),
  stop: vi.fn(),
  setFlipY: vi.fn<(flip: boolean) => void>(),
};

const mockImported = {
  release: vi.fn(),
  textureId: "mock-texture-id",
  getVideoFrame: vi.fn(),
};

const mockImportSharedTexture = vi.fn().mockReturnValue(mockImported);
const mockSendSharedTexture = vi
  .fn<(opts: unknown, ...args: unknown[]) => Promise<void>>()
  .mockResolvedValue(undefined);

const mockMainFrame = {};
const makeMockTarget = () => ({
  isDestroyed: vi.fn().mockReturnValue(false),
  mainFrame: mockMainFrame as unknown as Electron.WebFrameMain,
});

vi.mock("electron", () => ({
  sharedTexture: {
    importSharedTexture: (opts: unknown) => mockImportSharedTexture(opts),
    sendSharedTexture: (opts: unknown, ...args: unknown[]) => mockSendSharedTexture(opts, ...args),
  },
}));

const mockCloseNativeHandle = vi.fn<(handle: Buffer) => void>();

vi.mock("@napolab/texture-bridge-core", () => ({
  TextureReceiver: class MockTextureReceiver {
    receiveSharedTexture = mockReceiver.receiveSharedTexture;
    stop = mockReceiver.stop;
    setFlipY = mockReceiver.setFlipY;
  },
  closeNativeHandle: (handle: Buffer) => mockCloseNativeHandle(handle),
}));

import { createSharedTextureReceiver } from "../shared-texture-receiver";

const makeFrame = (overrides: Partial<MockFrame> = {}): MockFrame => ({
  width: 1920,
  height: 1080,
  pixelFormat: "bgra",
  ownerPid: 1234,
  handle: Buffer.alloc(8),
  ...overrides,
});

const flushPromises = async () => {
  // Drain the microtask queue enough rounds to settle chained ResultAsync
  // combinators — the exact hop count is an implementation detail the tests
  // must not pin.
  for (const _ of Array.from({ length: 10 })) {
    await Promise.resolve();
  }
};

describe("createSharedTextureReceiver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockReceiver.receiveSharedTexture.mockReturnValue(null);
    mockImportSharedTexture.mockReturnValue(mockImported);
    mockSendSharedTexture.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a bridge that is initially not disposed", () => {
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
    });
    expect(bridge.isDisposed).toBe(false);
    bridge.dispose();
  });

  it("polls receiveSharedTexture at pollIntervalMs after start()", () => {
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 20,
    });
    bridge.start();

    vi.advanceTimersByTime(25);
    expect(mockReceiver.receiveSharedTexture).toHaveBeenCalled();

    bridge.dispose();
  });

  it("does not poll before start()", () => {
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
    });
    vi.advanceTimersByTime(100);
    expect(mockReceiver.receiveSharedTexture).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("does not re-schedule on repeated start()", () => {
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.start();
    bridge.start();

    vi.advanceTimersByTime(30);
    // 3 ticks at 10ms interval across a single timer; second start() should be a no-op
    expect(mockReceiver.receiveSharedTexture.mock.calls.length).toBeLessThanOrEqual(4);

    bridge.dispose();
  });

  it("imports and sends a shared texture when a frame is received", async () => {
    const target = makeMockTarget();
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: target as unknown as Electron.WebContents,
      pollIntervalMs: 16,
    });
    bridge.start();

    vi.advanceTimersByTime(20);

    expect(mockImportSharedTexture).toHaveBeenCalledTimes(1);
    const importArg = mockImportSharedTexture.mock.calls[0][0] as {
      textureInfo: Electron.SharedTextureImportTextureInfo;
    };
    expect(importArg.textureInfo.codedSize).toEqual({ width: 1920, height: 1080 });
    expect(importArg.textureInfo.pixelFormat).toBe("bgra");

    expect(mockSendSharedTexture).toHaveBeenCalledTimes(1);
    const sendArg = mockSendSharedTexture.mock.calls[0][0] as {
      frame: unknown;
      importedSharedTexture: unknown;
    };
    expect(sendArg.frame).toBe(mockMainFrame);
    expect(sendArg.importedSharedTexture).toBe(mockImported);

    await flushPromises();
    expect(mockImported.release).toHaveBeenCalledTimes(1);

    bridge.dispose();
  });

  it("wraps handle under ntHandle on win32 and ioSurface on darwin", () => {
    const originalPlatform = process.platform;
    const setPlatform = (p: NodeJS.Platform) => {
      Object.defineProperty(process, "platform", { value: p, configurable: true });
    };

    try {
      setPlatform("win32");
      mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());
      const bridgeWin = createSharedTextureReceiver({
        senderName: "w",
        target: makeMockTarget() as unknown as Electron.WebContents,
        pollIntervalMs: 10,
      });
      bridgeWin.start();
      vi.advanceTimersByTime(15);
      const winArg = mockImportSharedTexture.mock.calls[0][0] as {
        textureInfo: { handle: { ntHandle?: Buffer; ioSurface?: Buffer } };
      };
      expect(winArg.textureInfo.handle.ntHandle).toBeInstanceOf(Buffer);
      expect(winArg.textureInfo.handle.ioSurface).toBeUndefined();
      bridgeWin.dispose();

      mockImportSharedTexture.mockClear();
      mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());
      setPlatform("darwin");
      const bridgeMac = createSharedTextureReceiver({
        senderName: "m",
        target: makeMockTarget() as unknown as Electron.WebContents,
        pollIntervalMs: 10,
      });
      bridgeMac.start();
      vi.advanceTimersByTime(15);
      const macArg = mockImportSharedTexture.mock.calls[0][0] as {
        textureInfo: { handle: { ntHandle?: Buffer; ioSurface?: Buffer } };
      };
      expect(macArg.textureInfo.handle.ioSurface).toBeInstanceOf(Buffer);
      expect(macArg.textureInfo.handle.ntHandle).toBeUndefined();
      bridgeMac.dispose();
    } finally {
      setPlatform(originalPlatform);
    }
  });

  it("emits 'error' when receiveSharedTexture throws", () => {
    const handler = vi.fn();
    mockReceiver.receiveSharedTexture.mockImplementation(() => {
      throw new Error("native boom");
    });

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", handler);
    bridge.start();
    vi.advanceTimersByTime(15);

    expect(handler).toHaveBeenCalled();
    expect(handler.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((handler.mock.calls[0][0] as Error).message).toBe("native boom");

    bridge.dispose();
  });

  it("emits 'error' when importSharedTexture throws and does not call sendSharedTexture", () => {
    const handler = vi.fn();
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());
    mockImportSharedTexture.mockImplementation(() => {
      throw new Error("import failed");
    });

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", handler);
    bridge.start();
    vi.advanceTimersByTime(15);

    expect(handler).toHaveBeenCalled();
    expect(mockSendSharedTexture).not.toHaveBeenCalled();

    bridge.dispose();
  });

  it("releases the imported texture even when sendSharedTexture rejects", async () => {
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());
    mockSendSharedTexture.mockRejectedValueOnce(new Error("send failed"));

    const handler = vi.fn();
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", handler);
    bridge.start();
    vi.advanceTimersByTime(15);

    await flushPromises();
    expect(mockImported.release).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalled();

    bridge.dispose();
  });

  it("skips import when the target webContents is destroyed", () => {
    const target = makeMockTarget();
    target.isDestroyed.mockReturnValue(true);
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: target as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.start();
    vi.advanceTimersByTime(15);

    expect(mockImportSharedTexture).not.toHaveBeenCalled();
    expect(mockSendSharedTexture).not.toHaveBeenCalled();

    bridge.dispose();
  });

  it("forwards extraArgs to sendSharedTexture varargs", () => {
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
      extraArgs: ["a", 42],
    });
    bridge.start();
    vi.advanceTimersByTime(15);

    const call = mockSendSharedTexture.mock.calls[0];
    expect(call[1]).toBe("a");
    expect(call[2]).toBe(42);

    bridge.dispose();
  });

  it("emits 'fps' after accumulating enough frames", async () => {
    const fpsHandler = vi.fn();
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("fps", fpsHandler);
    bridge.start();

    // async tick body + awaited sendSharedTexture require microtasks to flush
    // between timer fires. advanceTimersByTimeAsync interleaves both.
    await vi.advanceTimersByTimeAsync(1100);

    expect(fpsHandler).toHaveBeenCalled();
    const fps = fpsHandler.mock.calls[0][0];
    expect(typeof fps).toBe("number");
    expect(fps).toBeGreaterThan(0);

    bridge.dispose();
  });

  it("drops overlapping ticks while a send is in flight (drop-latest)", async () => {
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());
    // Never-resolving send keeps _inFlight true forever until we resolve it
    // explicitly via the ref below.
    const pendingResolve: { current: (() => void) | null } = { current: null };
    mockSendSharedTexture.mockImplementation(
      () =>
        new Promise<void>((res) => {
          pendingResolve.current = () => res();
        }),
    );

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.start();

    await vi.advanceTimersByTimeAsync(100);

    // Even with 10+ ticks in the window, only one import/send pair should be
    // dispatched because subsequent ticks hit the _inFlight guard.
    expect(mockImportSharedTexture).toHaveBeenCalledTimes(1);
    expect(mockSendSharedTexture).toHaveBeenCalledTimes(1);
    expect(mockImported.release).not.toHaveBeenCalled();

    // Let the send resolve; a later tick should now be free to dispatch again.
    pendingResolve.current?.();
    await vi.advanceTimersByTimeAsync(30);
    expect(mockImportSharedTexture.mock.calls.length).toBeGreaterThanOrEqual(2);

    bridge.dispose();
  });

  it("dispose() stops polling, stops the receiver, and emits 'disposed'", () => {
    const disposedHandler = vi.fn();
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("disposed", disposedHandler);
    bridge.start();

    bridge.dispose();

    expect(bridge.isDisposed).toBe(true);
    expect(mockReceiver.stop).toHaveBeenCalledTimes(1);
    expect(disposedHandler).toHaveBeenCalledTimes(1);

    const before = mockReceiver.receiveSharedTexture.mock.calls.length;
    vi.advanceTimersByTime(100);
    expect(mockReceiver.receiveSharedTexture.mock.calls.length).toBe(before);
  });

  it("dispose() is idempotent", () => {
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
    });
    bridge.dispose();
    bridge.dispose();
    expect(mockReceiver.stop).toHaveBeenCalledTimes(1);
  });

  it("[Symbol.dispose]() delegates to dispose()", () => {
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
    });
    bridge[Symbol.dispose]();
    expect(bridge.isDisposed).toBe(true);
    expect(mockReceiver.stop).toHaveBeenCalledTimes(1);
  });

  // -- pollIntervalMs validation ---------------------------------------------

  it("throws TypeError when pollIntervalMs is 0", () => {
    expect(() =>
      createSharedTextureReceiver({
        senderName: "test",
        target: makeMockTarget() as unknown as Electron.WebContents,
        pollIntervalMs: 0,
      }),
    ).toThrow(TypeError);
  });

  it("throws TypeError when pollIntervalMs is negative", () => {
    expect(() =>
      createSharedTextureReceiver({
        senderName: "test",
        target: makeMockTarget() as unknown as Electron.WebContents,
        pollIntervalMs: -1,
      }),
    ).toThrow(TypeError);
  });

  it("throws TypeError when pollIntervalMs is NaN", () => {
    expect(() =>
      createSharedTextureReceiver({
        senderName: "test",
        target: makeMockTarget() as unknown as Electron.WebContents,
        pollIntervalMs: Number.NaN,
      }),
    ).toThrow(TypeError);
  });

  it("throws TypeError when pollIntervalMs is Infinity", () => {
    expect(() =>
      createSharedTextureReceiver({
        senderName: "test",
        target: makeMockTarget() as unknown as Electron.WebContents,
        pollIntervalMs: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(TypeError);
  });

  it("does not throw when pollIntervalMs is undefined (uses default)", () => {
    expect(() =>
      createSharedTextureReceiver({
        senderName: "test",
        target: makeMockTarget() as unknown as Electron.WebContents,
      }),
    ).not.toThrow();
  });

  // -- flipY plumbing -------------------------------------------------------
  //
  // The native receiver defaults flipY=true. Only call setFlipY when the
  // caller passed an explicit value, so we don't override the native default
  // on platforms (Windows) where the call is a documented no-op.

  it("does not call setFlipY when flipY is undefined", () => {
    createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
    });
    expect(mockReceiver.setFlipY).not.toHaveBeenCalled();
  });

  it("calls setFlipY(false) when flipY: false is passed (opt-out)", () => {
    createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      flipY: false,
    });
    expect(mockReceiver.setFlipY).toHaveBeenCalledTimes(1);
    expect(mockReceiver.setFlipY).toHaveBeenCalledWith(false);
  });

  it("calls setFlipY(true) when flipY: true is passed (explicit opt-in)", () => {
    createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      flipY: true,
    });
    expect(mockReceiver.setFlipY).toHaveBeenCalledTimes(1);
    expect(mockReceiver.setFlipY).toHaveBeenCalledWith(true);
  });

  it("bridge.setFlipY() forwards to the underlying receiver for live toggle", () => {
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
    });
    bridge.setFlipY(false);
    bridge.setFlipY(true);
    expect(mockReceiver.setFlipY).toHaveBeenCalledTimes(2);
    expect(mockReceiver.setFlipY).toHaveBeenNthCalledWith(1, false);
    expect(mockReceiver.setFlipY).toHaveBeenNthCalledWith(2, true);
  });

  it("bridge.setFlipY() is a no-op after dispose", () => {
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
    });
    bridge.dispose();
    bridge.setFlipY(false);
    expect(mockReceiver.setFlipY).not.toHaveBeenCalled();
  });

  // -- _tick circuit breaker ------------------------------------------------

  it("stops and emits a final circuit-breaker error after 10 consecutive _tick errors", async () => {
    const errorHandler = vi.fn();
    mockReceiver.receiveSharedTexture.mockImplementation(() => {
      throw new Error("native boom");
    });

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", errorHandler);
    bridge.start();

    // 10 consecutive ticks → 10 per-tick error emits + 1 circuit-breaker emit.
    await vi.advanceTimersByTimeAsync(120);

    // Should have emitted exactly the 10 per-tick errors plus the final
    // circuit-breaker error.
    expect(errorHandler).toHaveBeenCalledTimes(11);
    const finalErr = errorHandler.mock.calls[10][0] as Error;
    expect(finalErr).toBeInstanceOf(Error);
    expect(finalErr.message).toMatch(/stopped after 10 consecutive errors/);

    // Receiver should now be stopped: further timer advancement must not
    // invoke receiveSharedTexture again.
    const callsBefore = mockReceiver.receiveSharedTexture.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(mockReceiver.receiveSharedTexture.mock.calls.length).toBe(callsBefore);

    bridge.dispose();
  });

  it("resets the consecutive-error counter after a successful tick", async () => {
    const errorHandler = vi.fn();
    let throwCount = 0;

    // First 5 ticks throw, then succeed, then 5 more throw.
    mockReceiver.receiveSharedTexture.mockImplementation(() => {
      throwCount += 1;
      if (throwCount <= 5 || (throwCount > 6 && throwCount <= 11)) {
        throw new Error(`boom ${throwCount}`);
      }
      return makeFrame();
    });

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", errorHandler);
    bridge.start();

    await vi.advanceTimersByTimeAsync(200);

    // We should NOT have tripped the circuit breaker: the successful tick at
    // throwCount===6 reset the consecutive counter, so the following 5 errors
    // are not enough to reach 10-in-a-row.
    const circuitBreakerErr = errorHandler.mock.calls.find((c) =>
      (c[0] as Error).message.includes("stopped after"),
    );
    expect(circuitBreakerErr).toBeUndefined();

    bridge.dispose();
  });

  it("trips the circuit breaker after 10 consecutive importSharedTexture failures", async () => {
    const errorHandler = vi.fn();
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());
    mockImportSharedTexture.mockImplementation(() => {
      throw new Error("import failed");
    });

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", errorHandler);
    bridge.start();

    // 10 consecutive import failures must emit 10 per-tick errors + 1
    // circuit-breaker error. In the buggy version `_tick` unconditionally
    // resets `_consecutiveErrors` when `_send` returns, so this would fail.
    await vi.advanceTimersByTimeAsync(120);

    const circuitBreakerErrs = errorHandler.mock.calls.filter((c) =>
      (c[0] as Error).message.includes("stopped after"),
    );
    expect(circuitBreakerErrs).toHaveLength(1);

    // Receiver must now be stopped: further timer advancement must not invoke
    // importSharedTexture again.
    const callsBefore = mockImportSharedTexture.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(mockImportSharedTexture.mock.calls.length).toBe(callsBefore);

    bridge.dispose();
  });

  it("trips the circuit breaker after 10 consecutive sendSharedTexture rejections", async () => {
    const errorHandler = vi.fn();
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());
    mockSendSharedTexture.mockRejectedValue(new Error("send failed"));

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", errorHandler);
    bridge.start();

    await vi.advanceTimersByTimeAsync(300);

    const circuitBreakerErrs = errorHandler.mock.calls.filter((c) =>
      (c[0] as Error).message.includes("stopped after"),
    );
    expect(circuitBreakerErrs).toHaveLength(1);

    bridge.dispose();
  });

  it("trips the circuit breaker after 10 consecutive unsupported pixelFormat frames", async () => {
    const errorHandler = vi.fn();
    mockReceiver.receiveSharedTexture.mockReturnValue(
      makeFrame({ pixelFormat: "something-weird" }),
    );

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", errorHandler);
    bridge.start();

    await vi.advanceTimersByTimeAsync(120);

    const circuitBreakerErrs = errorHandler.mock.calls.filter((c) =>
      (c[0] as Error).message.includes("stopped after"),
    );
    expect(circuitBreakerErrs).toHaveLength(1);

    bridge.dispose();
  });

  it("does not trip the circuit breaker on destroyed target (expected shutdown path)", async () => {
    const errorHandler = vi.fn();
    const target = makeMockTarget();
    target.isDestroyed.mockReturnValue(true);
    mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame());

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: target as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", errorHandler);
    bridge.start();

    await vi.advanceTimersByTimeAsync(300);

    // A destroyed target is an expected shutdown path and must not count as a
    // circuit-breaker error — no error of any kind must be emitted.
    expect(errorHandler).not.toHaveBeenCalled();

    bridge.dispose();
  });

  // -- pixelFormat validation ----------------------------------------------

  it("emits 'error' and skips import when pixelFormat is unknown", async () => {
    const errorHandler = vi.fn();
    mockReceiver.receiveSharedTexture.mockReturnValue(
      makeFrame({ pixelFormat: "something-weird" }),
    );

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", errorHandler);
    bridge.start();

    await vi.advanceTimersByTimeAsync(15);

    expect(mockImportSharedTexture).not.toHaveBeenCalled();
    expect(mockSendSharedTexture).not.toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalled();
    const err = errorHandler.mock.calls[0][0] as Error;
    expect(err.message).toMatch(/unsupported pixelFormat/);
    expect(err.message).toMatch(/something-weird/);

    bridge.dispose();
  });

  // -- native handle release on unconsumed paths ---------------------------

  it("releases the native handle when target webContents is destroyed", async () => {
    const errorHandler = vi.fn();
    const handleBuf = Buffer.alloc(8);
    handleBuf.writeUInt32LE(0xdeadbeef, 0);
    const frame = makeFrame({ handle: handleBuf });
    mockReceiver.receiveSharedTexture.mockReturnValue(frame);

    const target = makeMockTarget();
    target.isDestroyed.mockReturnValue(true);

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: target as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", errorHandler);
    bridge.start();

    await vi.advanceTimersByTimeAsync(15);

    expect(mockCloseNativeHandle).toHaveBeenCalledTimes(1);
    expect(mockCloseNativeHandle).toHaveBeenCalledWith(handleBuf);
    expect(mockImportSharedTexture).not.toHaveBeenCalled();
    // Destroyed target is an expected shutdown path, not an error.
    expect(errorHandler).not.toHaveBeenCalled();

    bridge.dispose();
  });

  it("releases the native handle when pixelFormat is unsupported", async () => {
    const errorHandler = vi.fn();
    const handleBuf = Buffer.alloc(8);
    handleBuf.writeUInt32LE(0x12345678, 0);
    const frame = makeFrame({ pixelFormat: "yuv420p", handle: handleBuf });
    mockReceiver.receiveSharedTexture.mockReturnValue(frame);

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", errorHandler);
    bridge.start();

    await vi.advanceTimersByTimeAsync(15);

    expect(mockCloseNativeHandle).toHaveBeenCalledTimes(1);
    expect(mockCloseNativeHandle).toHaveBeenCalledWith(handleBuf);
    expect(mockImportSharedTexture).not.toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalledTimes(1);
    const emitted = errorHandler.mock.calls[0][0] as Error;
    expect(emitted).toBeInstanceOf(Error);
    expect(emitted.message).toMatch(/unsupported pixelFormat/);
    expect(emitted.message).toMatch(/yuv420p/);

    bridge.dispose();
  });

  it("releases the native handle when importSharedTexture throws", async () => {
    const errorHandler = vi.fn();
    const handleBuf = Buffer.alloc(8);
    handleBuf.writeUInt32LE(0xcafebabe, 0);
    const frame = makeFrame({ handle: handleBuf });
    mockReceiver.receiveSharedTexture.mockReturnValue(frame);
    mockImportSharedTexture.mockImplementation(() => {
      throw new Error("import failed badly");
    });

    const bridge = createSharedTextureReceiver({
      senderName: "test",
      target: makeMockTarget() as unknown as Electron.WebContents,
      pollIntervalMs: 10,
    });
    bridge.on("error", errorHandler);
    bridge.start();

    await vi.advanceTimersByTimeAsync(15);

    expect(mockCloseNativeHandle).toHaveBeenCalledTimes(1);
    expect(mockCloseNativeHandle).toHaveBeenCalledWith(handleBuf);
    expect(mockSendSharedTexture).not.toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalledTimes(1);
    const emitted = errorHandler.mock.calls[0][0] as Error;
    expect(emitted).toBeInstanceOf(Error);
    expect(emitted.message).toBe("import failed badly");

    bridge.dispose();
  });

  it("accepts every pixelFormat the native receiver emits (bgra/rgba/rgbaf16)", async () => {
    const formats: readonly string[] = ["bgra", "rgba", "rgbaf16"];

    for (const fmt of formats) {
      mockImportSharedTexture.mockClear();
      mockSendSharedTexture.mockClear();
      mockReceiver.receiveSharedTexture.mockReturnValue(makeFrame({ pixelFormat: fmt }));

      const bridge = createSharedTextureReceiver({
        senderName: "test",
        target: makeMockTarget() as unknown as Electron.WebContents,
        pollIntervalMs: 10,
      });
      bridge.start();
      await vi.advanceTimersByTimeAsync(15);

      expect(mockImportSharedTexture).toHaveBeenCalledTimes(1);
      const arg = mockImportSharedTexture.mock.calls[0][0] as {
        textureInfo: Electron.SharedTextureImportTextureInfo;
      };
      expect(arg.textureInfo.pixelFormat).toBe(fmt);

      bridge.dispose();
    }
  });
});
