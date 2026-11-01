import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockFrame = {
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: string;
  readonly ownerPid: number;
  readonly handle: Buffer;
};

type MockImported = {
  readonly id: number;
  readonly release: ReturnType<typeof vi.fn>;
};

type SendCall = {
  readonly frame: unknown;
  readonly imported: MockImported;
  readonly args: readonly unknown[];
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

const mockReceiver = {
  receiveSharedTexture: vi.fn<() => MockFrame | null>().mockReturnValue(null),
  stop: vi.fn(),
  setFlipY: vi.fn<(flip: boolean) => void>(),
  onSharedTexture: vi.fn<(callback: ((frame: MockFrame) => void) | null) => void>(),
};

/** Every imported texture minted by the mock, in import order. */
const importedTextures: MockImported[] = [];
const mockImportSharedTexture = vi.fn((_opts: unknown): MockImported => {
  const imported = { id: importedTextures.length, release: vi.fn() };
  importedTextures.push(imported);
  return imported;
});

/** Every `sendSharedTexture` call, settled manually through resolve/reject. */
const sendCalls: SendCall[] = [];
/** mainFrames whose sends resolve immediately instead of waiting. */
const autoResolveFrames = new Set<unknown>();
/** mainFrames whose sends reject immediately. */
const autoRejectFrames = new Set<unknown>();

const mockSendSharedTexture = vi.fn(
  (opts: { frame: unknown; importedSharedTexture: MockImported }, ...args: unknown[]) =>
    new Promise<void>((resolve, reject) => {
      sendCalls.push({
        frame: opts.frame,
        imported: opts.importedSharedTexture,
        args,
        resolve,
        reject,
      });
      if (autoResolveFrames.has(opts.frame)) resolve();
      if (autoRejectFrames.has(opts.frame)) reject(new Error("send failed"));
    }),
);

vi.mock("electron", () => ({
  sharedTexture: {
    importSharedTexture: (opts: unknown) => mockImportSharedTexture(opts),
    sendSharedTexture: (
      opts: { frame: unknown; importedSharedTexture: MockImported },
      ...args: unknown[]
    ) => mockSendSharedTexture(opts, ...args),
  },
}));

const mockCloseNativeHandle = vi.fn<(handle: Buffer) => void>();

vi.mock("@napolab/texture-bridge-core", () => ({
  TextureReceiver: class MockTextureReceiver {
    receiveSharedTexture = mockReceiver.receiveSharedTexture;
    stop = mockReceiver.stop;
    setFlipY = mockReceiver.setFlipY;
    onSharedTexture = mockReceiver.onSharedTexture;
  },
  closeNativeHandle: (handle: Buffer) => mockCloseNativeHandle(handle),
}));

import { createSharedTextureReceiver } from "../shared-texture-receiver";
import { ReceiverStoppedError } from "../errors";
import type { ForwardStatus } from "../types";

type TargetStub = {
  readonly webContents: Electron.WebContents;
  readonly mainFrame: object;
  readonly emitter: EventEmitter;
  /** Mark destroyed and fire "destroyed", like Electron does. */
  destroy(): void;
};

/**
 * WebContents stub on a real EventEmitter (forwardFrames subscribes to
 * "destroyed" via once()). Each target has its own mainFrame so a send can
 * be attributed to its target.
 */
const makeTarget = (): TargetStub => {
  const mainFrame = {};
  const state = { destroyed: false };
  const emitter = Object.assign(new EventEmitter(), {
    mainFrame,
    isDestroyed: () => state.destroyed,
  });
  const stub: unknown = emitter;
  return {
    webContents: stub as Electron.WebContents,
    mainFrame,
    emitter,
    destroy: () => {
      state.destroyed = true;
      emitter.emit("destroyed");
    },
  };
};

const makeFrame = (byte: number): MockFrame => ({
  width: 1920,
  height: 1080,
  pixelFormat: "bgra",
  ownerPid: 1234,
  handle: Buffer.alloc(8, byte),
});

const flushPromises = async () => {
  for (const _ of Array.from({ length: 20 })) {
    await Promise.resolve();
  }
};

/** The push callback most recently registered via `onSharedTexture(fn)`. */
const capturedCallback = (): ((frame: MockFrame) => void) => {
  const registered = mockReceiver.onSharedTexture.mock.calls
    .map(([callback]) => callback)
    .filter((callback) => callback !== null);
  const last = registered.at(-1);
  if (!last) throw new Error("onSharedTexture was never called with a callback");
  return last;
};

const sendsTo = (target: TargetStub): SendCall[] =>
  sendCalls.filter((call) => call.frame === target.mainFrame);

const importedAt = (index: number): MockImported => {
  const imported = importedTextures[index];
  if (!imported) throw new Error(`no imported texture #${index}`);
  return imported;
};

const sendAt = (calls: readonly SendCall[], index: number): SendCall => {
  const call = calls[index];
  if (!call) throw new Error(`no send #${index}`);
  return call;
};

const originalPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform) => {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
};

describe("SharedTextureReceiverBridge.forwardFrames (fan-out)", () => {
  beforeEach(() => {
    setPlatform("linux");
    vi.useFakeTimers();
    vi.clearAllMocks();
    importedTextures.length = 0;
    sendCalls.length = 0;
    autoResolveFrames.clear();
    autoRejectFrames.clear();
    mockReceiver.receiveSharedTexture.mockReturnValue(null);
    mockReceiver.onSharedTexture.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    setPlatform(originalPlatform);
  });

  it("imports once per frame, sends to every target, and releases once after all sends settle", async () => {
    const primary = makeTarget();
    const extra = makeTarget();
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      mode: "push",
      target: primary.webContents,
      extraArgs: ["p"],
    });
    const forward = bridge.forwardFrames(extra.webContents, { extraArgs: ["x", 1] });
    expect(forward.active).toBe(true);
    bridge.start();

    const frame = makeFrame(0x1);
    capturedCallback()(frame);
    await flushPromises();

    expect(mockImportSharedTexture).toHaveBeenCalledTimes(1);
    expect(mockCloseNativeHandle).toHaveBeenCalledTimes(1);
    expect(mockCloseNativeHandle).toHaveBeenCalledWith(frame.handle);
    expect(sendsTo(primary).map((call) => call.args)).toEqual([["p"]]);
    expect(sendsTo(extra).map((call) => call.args)).toEqual([["x", 1]]);

    const imported = importedAt(0);
    sendAt(sendsTo(primary), 0).resolve();
    await flushPromises();
    expect(imported.release).not.toHaveBeenCalled();

    sendAt(sendsTo(extra), 0).resolve();
    await flushPromises();
    expect(imported.release).toHaveBeenCalledTimes(1);

    bridge.dispose();
    expect(imported.release).toHaveBeenCalledTimes(1);
  });

  it("works without a primary target (target-less receiver + forwards)", async () => {
    const a = makeTarget();
    const b = makeTarget();
    autoResolveFrames.add(a.mainFrame);
    autoResolveFrames.add(b.mainFrame);
    const bridge = createSharedTextureReceiver({ senderName: "test", mode: "push" });
    bridge.forwardFrames(a.webContents, { extraArgs: [0] });
    bridge.forwardFrames(b.webContents, { extraArgs: [1] });
    bridge.start();

    capturedCallback()(makeFrame(0x1));
    await flushPromises();

    expect(mockImportSharedTexture).toHaveBeenCalledTimes(1);
    expect(sendsTo(a).map((call) => call.args)).toEqual([[0]]);
    expect(sendsTo(b).map((call) => call.args)).toEqual([[1]]);
    expect(importedAt(0).release).toHaveBeenCalledTimes(1);

    bridge.dispose();
  });

  it("delivers through the same path in poll mode", async () => {
    const a = makeTarget();
    const b = makeTarget();
    autoResolveFrames.add(a.mainFrame);
    autoResolveFrames.add(b.mainFrame);
    mockReceiver.receiveSharedTexture.mockReturnValueOnce(makeFrame(0x1));
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      mode: "poll",
      pollIntervalMs: 10,
      target: a.webContents,
    });
    bridge.forwardFrames(b.webContents);
    bridge.start();

    await vi.advanceTimersByTimeAsync(15);

    expect(mockImportSharedTexture).toHaveBeenCalledTimes(1);
    expect(sendsTo(a)).toHaveLength(1);
    expect(sendsTo(b)).toHaveLength(1);
    expect(importedAt(0).release).toHaveBeenCalledTimes(1);

    bridge.dispose();
  });

  it("a slow target only drops its own frames and catches up with the latest one", async () => {
    const slow = makeTarget();
    const fast = makeTarget();
    autoResolveFrames.add(fast.mainFrame);
    const bridge = createSharedTextureReceiver({ senderName: "test", mode: "push" });
    bridge.forwardFrames(slow.webContents);
    bridge.forwardFrames(fast.webContents);
    bridge.start();
    const push = capturedCallback();

    push(makeFrame(0x1));
    await flushPromises();
    push(makeFrame(0x2));
    await flushPromises();
    push(makeFrame(0x3));
    await flushPromises();

    // The fast target got every frame, each imported exactly once.
    expect(mockImportSharedTexture).toHaveBeenCalledTimes(3);
    expect(sendsTo(fast).map((call) => call.imported.id)).toEqual([0, 1, 2]);
    // The slow target is still on frame 1; frame 2 was superseded by frame 3.
    expect(sendsTo(slow).map((call) => call.imported.id)).toEqual([0]);
    expect(importedAt(0).release).not.toHaveBeenCalled();
    expect(importedAt(1).release).toHaveBeenCalledTimes(1);
    expect(importedAt(2).release).not.toHaveBeenCalled();

    sendAt(sendsTo(slow), 0).resolve();
    await flushPromises();

    expect(importedAt(0).release).toHaveBeenCalledTimes(1);
    expect(sendsTo(slow).map((call) => call.imported.id)).toEqual([0, 2]);

    sendAt(sendsTo(slow), 1).resolve();
    await flushPromises();
    expect(importedAt(2).release).toHaveBeenCalledTimes(1);
    expect(mockCloseNativeHandle).toHaveBeenCalledTimes(3);

    bridge.dispose();
  });

  it("holds the newest frame unimported while every target is busy", async () => {
    const a = makeTarget();
    const b = makeTarget();
    const bridge = createSharedTextureReceiver({ senderName: "test", mode: "push" });
    bridge.forwardFrames(a.webContents);
    bridge.forwardFrames(b.webContents);
    bridge.start();
    const push = capturedCallback();

    const f1 = makeFrame(0x1);
    const f2 = makeFrame(0x2);
    const f3 = makeFrame(0x3);
    push(f1);
    push(f2);
    push(f3);
    await flushPromises();

    expect(mockImportSharedTexture).toHaveBeenCalledTimes(1);
    expect(mockCloseNativeHandle.mock.calls.map(([handle]) => handle)).toEqual([
      f1.handle,
      f2.handle,
    ]);

    sendAt(sendsTo(a), 0).resolve();
    await flushPromises();

    // The first free target pulls the newest frame; b is still busy and
    // queues a reference to it.
    expect(mockImportSharedTexture).toHaveBeenCalledTimes(2);
    expect(sendsTo(a).map((call) => call.imported.id)).toEqual([0, 1]);
    expect(sendsTo(b).map((call) => call.imported.id)).toEqual([0]);

    sendAt(sendsTo(b), 0).resolve();
    await flushPromises();
    expect(importedAt(0).release).toHaveBeenCalledTimes(1);
    expect(sendsTo(b).map((call) => call.imported.id)).toEqual([0, 1]);

    sendAt(sendsTo(a), 1).resolve();
    sendAt(sendsTo(b), 1).resolve();
    await flushPromises();
    expect(importedAt(1).release).toHaveBeenCalledTimes(1);

    bridge.dispose();
  });

  // -- Review Focus 1 --------------------------------------------------------

  it("a target destroyed mid-send still releases the imported texture once; others keep receiving", async () => {
    const doomed = makeTarget();
    const survivor = makeTarget();
    autoResolveFrames.add(survivor.mainFrame);
    const errors: Error[] = [];
    const statuses: ForwardStatus[] = [];
    const bridge = createSharedTextureReceiver({ senderName: "test", mode: "push" });
    bridge.on("error", (error) => errors.push(error));
    const doomedForward = bridge.forwardFrames(doomed.webContents, {
      onStatus: (status) => statuses.push(status),
    });
    bridge.forwardFrames(survivor.webContents);
    bridge.start();
    const push = capturedCallback();

    push(makeFrame(0x1));
    await flushPromises();
    push(makeFrame(0x2)); // queued for the doomed target
    await flushPromises();

    doomed.destroy();
    expect(doomedForward.active).toBe(false);
    // Its pending reference was dropped with it.
    expect(importedAt(1).release).toHaveBeenCalledTimes(1);

    sendAt(sendsTo(doomed), 0).reject(new Error("frame gone"));
    await flushPromises();
    expect(importedAt(0).release).toHaveBeenCalledTimes(1);

    push(makeFrame(0x3));
    await flushPromises();

    expect(sendsTo(doomed)).toHaveLength(1);
    expect(sendsTo(survivor).map((call) => call.imported.id)).toEqual([0, 1, 2]);
    expect(importedAt(2).release).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
    // A settle that lands after the registration died reports nothing.
    expect(statuses).toEqual([]);

    bridge.dispose();
  });

  // -- Review Focus 2 --------------------------------------------------------

  it("forward.dispose() mid-send drops its pending reference and stops sends to that target", async () => {
    const slow = makeTarget();
    const fast = makeTarget();
    autoResolveFrames.add(fast.mainFrame);
    const bridge = createSharedTextureReceiver({ senderName: "test", mode: "push" });
    const slowForward = bridge.forwardFrames(slow.webContents);
    bridge.forwardFrames(fast.webContents);
    bridge.start();
    const push = capturedCallback();

    push(makeFrame(0x1));
    await flushPromises();
    push(makeFrame(0x2)); // pending on slow, already delivered to fast
    await flushPromises();
    expect(importedAt(1).release).not.toHaveBeenCalled();

    slowForward.dispose();
    slowForward.dispose(); // idempotent

    expect(slowForward.active).toBe(false);
    expect(importedAt(1).release).toHaveBeenCalledTimes(1);
    expect(slow.emitter.listenerCount("destroyed")).toBe(0);

    sendAt(sendsTo(slow), 0).resolve();
    await flushPromises();
    expect(importedAt(0).release).toHaveBeenCalledTimes(1);

    push(makeFrame(0x3));
    await flushPromises();
    expect(sendsTo(slow)).toHaveLength(1);
    expect(sendsTo(fast)).toHaveLength(3);

    bridge.dispose();
  });

  // -- Review Focus 3 --------------------------------------------------------

  it("receiver.dispose() with several targets mid-flight releases every texture once and sends nothing more", async () => {
    const a = makeTarget();
    const b = makeTarget();
    const c = makeTarget();
    autoResolveFrames.add(c.mainFrame);
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      mode: "push",
      target: a.webContents,
    });
    bridge.forwardFrames(b.webContents);
    bridge.forwardFrames(c.webContents);
    bridge.start();
    const push = capturedCallback();

    push(makeFrame(0x1)); // a, b in flight; c done
    await flushPromises();
    push(makeFrame(0x2)); // queued on a and b; delivered to c
    await flushPromises();
    const sendsBefore = sendCalls.length;

    bridge.dispose();

    expect(importedAt(1).release).toHaveBeenCalledTimes(1);
    expect(importedAt(0).release).not.toHaveBeenCalled();
    expect(b.emitter.listenerCount("destroyed")).toBe(0);
    expect(c.emitter.listenerCount("destroyed")).toBe(0);

    sendAt(sendsTo(a), 0).resolve();
    sendAt(sendsTo(b), 0).resolve();
    await flushPromises();

    expect(importedAt(0).release).toHaveBeenCalledTimes(1);
    expect(importedAt(1).release).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveLength(sendsBefore);
  });

  it("stop() with every target busy closes the held native frame and sends nothing after return", async () => {
    const a = makeTarget();
    const b = makeTarget();
    const bridge = createSharedTextureReceiver({ senderName: "test", mode: "push" });
    bridge.forwardFrames(a.webContents);
    bridge.forwardFrames(b.webContents);
    bridge.start();
    const push = capturedCallback();

    const f1 = makeFrame(0x1);
    const held = makeFrame(0x2);
    push(f1);
    push(held);
    await flushPromises();

    bridge.stop();
    expect(mockCloseNativeHandle.mock.calls.map(([handle]) => handle)).toEqual([
      f1.handle,
      held.handle,
    ]);

    sendAt(sendsTo(a), 0).resolve();
    sendAt(sendsTo(b), 0).resolve();
    await flushPromises();

    expect(mockImportSharedTexture).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveLength(2);
    expect(importedAt(0).release).toHaveBeenCalledTimes(1);

    bridge.dispose();
  });

  it("stop() drops per-target pending references; restarting does not resend them", async () => {
    const slow = makeTarget();
    const fast = makeTarget();
    autoResolveFrames.add(fast.mainFrame);
    const bridge = createSharedTextureReceiver({ senderName: "test", mode: "push" });
    bridge.forwardFrames(slow.webContents);
    bridge.forwardFrames(fast.webContents);
    bridge.start();
    const push = capturedCallback();

    push(makeFrame(0x1));
    await flushPromises();
    push(makeFrame(0x2));
    await flushPromises();

    bridge.stop();
    expect(importedAt(1).release).toHaveBeenCalledTimes(1);

    sendAt(sendsTo(slow), 0).resolve();
    await flushPromises();
    expect(sendsTo(slow)).toHaveLength(1);
    expect(importedAt(0).release).toHaveBeenCalledTimes(1);

    bridge.start();
    await flushPromises();
    expect(sendsTo(slow)).toHaveLength(1);

    bridge.dispose();
  });

  // -- Review Focus 4 --------------------------------------------------------

  it("does not import at all when no target is live (push)", async () => {
    const a = makeTarget();
    const bridge = createSharedTextureReceiver({ senderName: "test", mode: "push" });
    const forward = bridge.forwardFrames(a.webContents);
    forward.dispose();
    bridge.start();

    const frame = makeFrame(0x1);
    capturedCallback()(frame);
    await flushPromises();

    expect(mockImportSharedTexture).not.toHaveBeenCalled();
    expect(mockSendSharedTexture).not.toHaveBeenCalled();
    expect(mockCloseNativeHandle).toHaveBeenCalledTimes(1);
    expect(mockCloseNativeHandle).toHaveBeenCalledWith(frame.handle);

    bridge.dispose();
    expect(mockCloseNativeHandle).toHaveBeenCalledTimes(1);
  });

  it("does not import at all when no target is live (poll)", async () => {
    const frame = makeFrame(0x1);
    mockReceiver.receiveSharedTexture.mockReturnValueOnce(frame);
    const errors: Error[] = [];
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      mode: "poll",
      pollIntervalMs: 10,
    });
    bridge.on("error", (error) => errors.push(error));
    bridge.start();

    await vi.advanceTimersByTimeAsync(15);

    expect(mockImportSharedTexture).not.toHaveBeenCalled();
    expect(mockCloseNativeHandle).toHaveBeenCalledTimes(1);
    expect(mockCloseNativeHandle).toHaveBeenCalledWith(frame.handle);
    expect(errors).toEqual([]);

    bridge.dispose();
  });

  // -- Review Focus 5 --------------------------------------------------------

  it("a forward whose sends keep rejecting reports via onStatus only and never trips the breaker", async () => {
    const primary = makeTarget();
    const broken = makeTarget();
    autoResolveFrames.add(primary.mainFrame);
    autoRejectFrames.add(broken.mainFrame);
    const errors: Error[] = [];
    const statuses: ForwardStatus[] = [];
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      mode: "push",
      target: primary.webContents,
    });
    bridge.on("error", (error) => errors.push(error));
    bridge.forwardFrames(broken.webContents, { onStatus: (status) => statuses.push(status) });
    bridge.start();
    const push = capturedCallback();

    for (const index of Array.from({ length: 15 }, (_, i) => i)) {
      push(makeFrame(index));
      await flushPromises();
    }

    expect(errors).toEqual([]);
    expect(errors.some((error) => error instanceof ReceiverStoppedError)).toBe(false);
    expect(sendsTo(primary)).toHaveLength(15);
    expect(sendsTo(broken)).toHaveLength(15);
    expect(statuses).toHaveLength(1);
    const [failed] = statuses;
    expect(failed).toMatchObject({ ok: false, reason: "send-failed" });
    for (const imported of importedTextures) {
      expect(imported.release).toHaveBeenCalledTimes(1);
    }

    // Recovery is reported once.
    autoRejectFrames.delete(broken.mainFrame);
    autoResolveFrames.add(broken.mainFrame);
    push(makeFrame(0x20));
    await flushPromises();
    push(makeFrame(0x21));
    await flushPromises();
    expect(statuses).toEqual([failed, { ok: true }]);

    bridge.dispose();
  });

  it("primary-target send failures still emit 'error' while forwards are attached", async () => {
    const primary = makeTarget();
    const extra = makeTarget();
    autoRejectFrames.add(primary.mainFrame);
    autoResolveFrames.add(extra.mainFrame);
    const errors: Error[] = [];
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      mode: "push",
      target: primary.webContents,
    });
    bridge.on("error", (error) => errors.push(error));
    bridge.forwardFrames(extra.webContents);
    bridge.start();

    capturedCallback()(makeFrame(0x1));
    await flushPromises();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("send failed");
    expect(sendsTo(extra)).toHaveLength(1);
    expect(importedAt(0).release).toHaveBeenCalledTimes(1);

    bridge.dispose();
  });

  it("reports import failures to every live forward's onStatus", async () => {
    mockImportSharedTexture.mockImplementationOnce(() => {
      throw new Error("import boom");
    });
    const a = makeTarget();
    const statuses: ForwardStatus[] = [];
    const errors: Error[] = [];
    const bridge = createSharedTextureReceiver({ senderName: "test", mode: "push" });
    bridge.on("error", (error) => errors.push(error));
    bridge.forwardFrames(a.webContents, { onStatus: (status) => statuses.push(status) });
    bridge.start();

    capturedCallback()(makeFrame(0x1));
    await flushPromises();

    expect(errors).toHaveLength(1);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ ok: false, reason: "import-failed" });
    expect(mockCloseNativeHandle).toHaveBeenCalledTimes(1);

    bridge.dispose();
  });

  it("swallows a throwing onStatus without breaking delivery", async () => {
    const a = makeTarget();
    autoResolveFrames.add(a.mainFrame);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bridge = createSharedTextureReceiver({ senderName: "test", mode: "push" });
    bridge.forwardFrames(a.webContents, {
      onStatus: () => {
        throw new Error("observer boom");
      },
    });
    bridge.start();
    const push = capturedCallback();

    push(makeFrame(0x1));
    await flushPromises();
    push(makeFrame(0x2));
    await flushPromises();

    expect(sendsTo(a)).toHaveLength(2);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
    bridge.dispose();
  });

  // -- fps -------------------------------------------------------------------

  it("ticks fps when a frame reaches at least one target", async () => {
    const a = makeTarget();
    autoResolveFrames.add(a.mainFrame);
    mockReceiver.receiveSharedTexture.mockImplementation(() => makeFrame(0x1));
    const fps = vi.fn();
    const bridge = createSharedTextureReceiver({
      senderName: "test",
      mode: "poll",
      pollIntervalMs: 10,
    });
    bridge.on("fps", fps);
    bridge.forwardFrames(a.webContents);
    bridge.start();

    await vi.advanceTimersByTimeAsync(1100);

    expect(fps).toHaveBeenCalled();
    bridge.dispose();
  });

  // -- registration lifecycle --------------------------------------------------

  it("returns an inert handle after the receiver is disposed", () => {
    const a = makeTarget();
    const bridge = createSharedTextureReceiver({ senderName: "test", mode: "push" });
    bridge.dispose();

    const forward = bridge.forwardFrames(a.webContents);

    expect(forward.active).toBe(false);
    expect(a.emitter.listenerCount("destroyed")).toBe(0);
    expect(() => forward.dispose()).not.toThrow();
  });

  it("returns an inert handle for an already-destroyed target", () => {
    const a = makeTarget();
    a.destroy();
    const bridge = createSharedTextureReceiver({ senderName: "test", mode: "push" });

    const forward = bridge.forwardFrames(a.webContents);

    expect(forward.active).toBe(false);
    expect(a.emitter.listenerCount("destroyed")).toBe(0);
    bridge.dispose();
  });

  it("does not accumulate 'destroyed' listeners across register/dispose cycles", () => {
    const a = makeTarget();
    const bridge = createSharedTextureReceiver({ senderName: "test", mode: "push" });

    for (const _ of Array.from({ length: 20 })) {
      bridge.forwardFrames(a.webContents).dispose();
    }

    expect(a.emitter.listenerCount("destroyed")).toBe(0);
    bridge.dispose();
  });

  it("goes inactive when the receiver is disposed", () => {
    const a = makeTarget();
    const bridge = createSharedTextureReceiver({ senderName: "test", mode: "push" });
    const forward = bridge.forwardFrames(a.webContents);

    bridge.dispose();

    expect(forward.active).toBe(false);
    expect(a.emitter.listenerCount("destroyed")).toBe(0);
  });
});
