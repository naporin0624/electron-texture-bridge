import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mockReceiver = {
  hasNewFrame: vi.fn().mockReturnValue(false),
  receiveFrame: vi.fn().mockReturnValue(null),
  isConnected: vi.fn().mockReturnValue(true),
  getWidth: vi.fn().mockReturnValue(1920),
  getHeight: vi.fn().mockReturnValue(1080),
  stop: vi.fn(),
  platform: vi.fn().mockReturnValue("mock"),
};

vi.mock("@napolab/texture-bridge-core", () => ({
  TextureReceiver: class MockTextureReceiver {
    hasNewFrame = mockReceiver.hasNewFrame;
    receiveFrame = mockReceiver.receiveFrame;
    isConnected = mockReceiver.isConnected;
    getWidth = mockReceiver.getWidth;
    getHeight = mockReceiver.getHeight;
    stop = mockReceiver.stop;
    platform = mockReceiver.platform;
  },
  listSenders: vi.fn().mockReturnValue([]),
}));

import { createTextureReceiver } from "../receiver";

describe("TextureReceiverBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockReceiver.hasNewFrame.mockReturnValue(false);
    mockReceiver.receiveFrame.mockReturnValue(null);
    mockReceiver.isConnected.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("createTextureReceiver returns a bridge object", () => {
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    expect(bridge).toBeDefined();
    expect(bridge.isDisposed).toBe(false);
    bridge.dispose();
  });

  it("start() begins polling for frames", () => {
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.start();

    vi.advanceTimersByTime(20);
    expect(mockReceiver.hasNewFrame).toHaveBeenCalled();

    bridge.dispose();
  });

  it("emits 'frame' when a new frame is available", () => {
    const handler = vi.fn();
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.on("frame", handler);
    bridge.start();

    mockReceiver.hasNewFrame.mockReturnValue(true);
    mockReceiver.receiveFrame.mockReturnValue({
      data: Buffer.from([1, 2, 3, 4]),
      width: 100,
      height: 100,
    });

    vi.advanceTimersByTime(20);

    expect(handler).toHaveBeenCalledWith({
      data: Buffer.from([1, 2, 3, 4]),
      width: 100,
      height: 100,
    });

    bridge.dispose();
  });

  it("emits 'fps' event periodically", () => {
    const handler = vi.fn();
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.on("fps", handler);
    bridge.start();

    // Simulate frames for > 1 second
    mockReceiver.hasNewFrame.mockReturnValue(true);
    mockReceiver.receiveFrame.mockReturnValue({
      data: Buffer.from([0]),
      width: 1,
      height: 1,
    });

    // Advance 1100ms (at ~16ms interval, about 68 frames)
    vi.advanceTimersByTime(1100);

    expect(handler).toHaveBeenCalled();
    const fps = handler.mock.calls[0][0];
    expect(typeof fps).toBe("number");
    expect(fps).toBeGreaterThan(0);

    bridge.dispose();
  });

  it("dispose() stops polling and calls receiver.stop()", () => {
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.start();

    bridge.dispose();

    expect(mockReceiver.stop).toHaveBeenCalled();
    expect(bridge.isDisposed).toBe(true);

    // No more polling after dispose
    const callCount = mockReceiver.hasNewFrame.mock.calls.length;
    vi.advanceTimersByTime(100);
    expect(mockReceiver.hasNewFrame.mock.calls.length).toBe(callCount);
  });

  it("dispose() is idempotent", () => {
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.dispose();
    bridge.dispose(); // should not throw
    expect(mockReceiver.stop).toHaveBeenCalledTimes(1);
  });

  it("stop() then start() does not emit bogus FPS from paused interval", () => {
    const fpsHandler = vi.fn();
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.on("fps", fpsHandler);

    mockReceiver.hasNewFrame.mockReturnValue(true);
    mockReceiver.receiveFrame.mockReturnValue({
      data: Buffer.from([0]),
      width: 1,
      height: 1,
    });

    // Run for 500ms (accumulate some frames but not enough for FPS report)
    bridge.start();
    vi.advanceTimersByTime(500);

    // Pause for 5 seconds
    bridge.stop();
    vi.advanceTimersByTime(5000);

    // Restart — FPS counter should be reset, no bogus near-zero reading
    fpsHandler.mockClear();
    bridge.start();
    vi.advanceTimersByTime(1100);

    // FPS should reflect actual frame rate after restart, not near-zero
    expect(fpsHandler).toHaveBeenCalled();
    const fps = fpsHandler.mock.calls[0][0];
    // At 16ms polling, expect ~60 FPS, not near-zero from the 5s pause
    expect(fps).toBeGreaterThan(30);

    bridge.dispose();
  });

  it("emits 'error' when receiveFrame throws", () => {
    const handler = vi.fn();
    const bridge = createTextureReceiver({ senderName: "TestSender" });
    bridge.on("error", handler);
    bridge.start();

    mockReceiver.hasNewFrame.mockReturnValue(true);
    mockReceiver.receiveFrame.mockImplementation(() => {
      throw new Error("GPU error");
    });

    vi.advanceTimersByTime(20);

    expect(handler).toHaveBeenCalled();
    expect(handler.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(handler.mock.calls[0][0].message).toBe("GPU error");

    bridge.dispose();
  });
});
