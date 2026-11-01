import { describe, expect, it, vi } from "vitest";
import { bindSharedTextureReceiver } from "../client/shared-texture-consumer";
import {
  SharedTextureReceiverAlreadyBoundError,
  SharedTextureReceiverDisposedError,
} from "../errors";

type ReceiverCallback = (
  data: Electron.ReceivedSharedTextureData,
  ...args: unknown[]
) => Promise<void>;

// The bound receiver defers `imported.release()` by one macrotask to avoid
// racing ahead of Electron's main-side tracker update (see implementation
// comment). Tests that assert on release side effects must flush the
// macrotask queue after invoking the installed callback.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const makeMockVideoFrame = () =>
  ({
    close: vi.fn(),
  }) as unknown as VideoFrame;

const makeMockImported = (videoFrameFactory?: () => VideoFrame) => {
  const getVideoFrame = vi.fn(videoFrameFactory ?? (() => makeMockVideoFrame()));
  return {
    textureId: "tex-abc",
    release: vi.fn(),
    getVideoFrame,
  };
};

const makeMockData = (
  imported?: ReturnType<typeof makeMockImported>,
): Electron.ReceivedSharedTextureData => ({
  importedSharedTexture: (imported ??
    makeMockImported()) as unknown as Electron.SharedTextureImported,
});

/** A fresh fake `sharedTexture` target per test — no module mocking, no reset. */
const makeTarget = () => ({ setSharedTextureReceiver: vi.fn<(cb: ReceiverCallback) => void>() });

type FakeTarget = ReturnType<typeof makeTarget>;

/** The callback most recently installed on the fake target (Electron is last-wins). */
const installedCallback = (target: FakeTarget): ReceiverCallback => {
  const cb = target.setSharedTextureReceiver.mock.lastCall?.[0];
  if (cb === undefined) throw new Error("no receiver callback installed on target");
  return cb;
};

/** Bind a fresh target and return both the handle and a frame-delivery helper. */
const setup = () => {
  const target = makeTarget();
  const bound = bindSharedTextureReceiver(target);
  const deliver = (data: Electron.ReceivedSharedTextureData, ...args: unknown[]) =>
    installedCallback(target)(data, ...args);
  return { target, bound, deliver };
};

type SharedTextureConsumerFrameLike = {
  textureId: string;
  videoFrame: VideoFrame;
};

describe("bindSharedTextureReceiver — binding lifecycle", () => {
  it("installs exactly one callback on the injected target", () => {
    const { target } = setup();
    expect(target.setSharedTextureReceiver).toHaveBeenCalledTimes(1);
    expect(typeof installedCallback(target)).toBe("function");
  });

  it("throws SharedTextureReceiverAlreadyBoundError when the same target is bound twice", () => {
    const { target } = setup();
    expect(() => bindSharedTextureReceiver(target)).toThrow(SharedTextureReceiverAlreadyBoundError);
    // The failed bind must not overwrite the existing callback.
    expect(target.setSharedTextureReceiver).toHaveBeenCalledTimes(1);
  });

  it("the already-bound error has a stable name", () => {
    const { target } = setup();
    try {
      bindSharedTextureReceiver(target);
      expect.unreachable("second bind should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SharedTextureReceiverAlreadyBoundError);
      expect((err as Error).name).toBe("SharedTextureReceiverAlreadyBoundError");
    }
  });

  it("binding distinct targets is independent", () => {
    const a = setup();
    const b = setup();
    expect(a.target.setSharedTextureReceiver).toHaveBeenCalledTimes(1);
    expect(b.target.setSharedTextureReceiver).toHaveBeenCalledTimes(1);
    a.bound.dispose();
    b.bound.dispose();
  });

  it("allows re-binding the same target after dispose (Electron last-wins replaces the callback)", async () => {
    const { target, bound } = setup();
    const firstCallback = installedCallback(target);
    bound.dispose();

    const rebound = bindSharedTextureReceiver(target);
    expect(target.setSharedTextureReceiver).toHaveBeenCalledTimes(2);
    expect(installedCallback(target)).not.toBe(firstCallback);

    const onFrame = vi.fn();
    const reg = rebound.consume({ onFrame });
    const imported = makeMockImported();
    await installedCallback(target)(makeMockData(imported));
    await flush();
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(imported.release).toHaveBeenCalledTimes(1);

    reg.dispose();
    rebound.dispose();
  });

  it("consume() after dispose throws SharedTextureReceiverDisposedError", () => {
    const { bound } = setup();
    bound.dispose();
    expect(() => bound.consume({ onFrame: vi.fn() })).toThrow(SharedTextureReceiverDisposedError);
  });

  it("the disposed error has a stable name", () => {
    const { bound } = setup();
    bound.dispose();
    try {
      bound.consume({ onFrame: vi.fn() });
      expect.unreachable("consume after dispose should throw");
    } catch (err) {
      expect((err as Error).name).toBe("SharedTextureReceiverDisposedError");
    }
  });

  it("dispose() is idempotent and never re-touches the target", () => {
    const { target, bound } = setup();
    bound.dispose();
    expect(() => bound.dispose()).not.toThrow();
    expect(() => bound.dispose()).not.toThrow();
    expect(target.setSharedTextureReceiver).toHaveBeenCalledTimes(1);
  });

  it("a stale handle's dispose() after re-bind does not unbind the new handle", () => {
    const { target, bound } = setup();
    bound.dispose();
    const rebound = bindSharedTextureReceiver(target);

    bound.dispose();

    // The target is still bound by `rebound`, so a third bind must still throw.
    expect(() => bindSharedTextureReceiver(target)).toThrow(SharedTextureReceiverAlreadyBoundError);
    expect(() => rebound.consume({ onFrame: vi.fn() }).dispose()).not.toThrow();
    rebound.dispose();
  });

  it("dispose() stops delivery to consumers registered before dispose", async () => {
    const { bound, deliver } = setup();
    const onFrame = vi.fn();
    bound.consume({ onFrame });
    bound.dispose();

    const imported = makeMockImported();
    await deliver(makeMockData(imported));
    await flush();

    expect(onFrame).not.toHaveBeenCalled();
    expect(imported.getVideoFrame).not.toHaveBeenCalled();
  });

  it("frames arriving after dispose are still released exactly once", async () => {
    const { bound, deliver } = setup();
    bound.dispose();

    const imported = makeMockImported();
    await deliver(makeMockData(imported));
    expect(imported.release).not.toHaveBeenCalled();
    await flush();
    expect(imported.release).toHaveBeenCalledTimes(1);
  });

  it("consume() never touches the Electron slot — it is purely a pool registration", () => {
    const { target, bound } = setup();
    const reg = bound.consume({ onFrame: vi.fn() });
    reg.dispose();
    bound.consume({ onFrame: vi.fn() }).dispose();
    expect(target.setSharedTextureReceiver).toHaveBeenCalledTimes(1);
  });
});

describe("bindSharedTextureReceiver — consume", () => {
  it("invokes a single consumer with { textureId, videoFrame } and forwards extra args", async () => {
    const { bound, deliver } = setup();
    const onFrame = vi.fn();
    const reg = bound.consume({ onFrame });

    const videoFrame = makeMockVideoFrame();
    const imported = makeMockImported(() => videoFrame);
    await deliver(makeMockData(imported), "extra1", 7);

    expect(onFrame).toHaveBeenCalledTimes(1);
    const [frameArg, extra1, extra2] = onFrame.mock.calls[0];
    expect(frameArg).toMatchObject({ textureId: "tex-abc", videoFrame });
    expect(extra1).toBe("extra1");
    expect(extra2).toBe(7);
    await flush();
    expect(imported.release).toHaveBeenCalledTimes(1);

    reg.dispose();
  });

  it("defers imported.release() to the next macrotask so the release IPC cannot race ahead of main-side tracker registration", async () => {
    const { bound, deliver } = setup();
    const reg = bound.consume({ onFrame: vi.fn() });

    const imported = makeMockImported();
    await deliver(makeMockData(imported));

    // The callback has resolved, the consumer has run, but release is
    // queued on the next macrotask — not fired yet.
    expect(imported.release).not.toHaveBeenCalled();

    await flush();
    expect(imported.release).toHaveBeenCalledTimes(1);

    reg.dispose();
  });

  it("delivers each frame to every active consumer with its own VideoFrame", async () => {
    const { bound, deliver } = setup();
    const onFrameA = vi.fn();
    const onFrameB = vi.fn();
    const regA = bound.consume({ onFrame: onFrameA });
    const regB = bound.consume({ onFrame: onFrameB });

    const frameA = makeMockVideoFrame();
    const frameB = makeMockVideoFrame();
    const frames = [frameA, frameB];
    const imported = makeMockImported(() => frames.shift() ?? makeMockVideoFrame());

    await deliver(makeMockData(imported));

    expect(onFrameA).toHaveBeenCalledTimes(1);
    expect(onFrameB).toHaveBeenCalledTimes(1);
    expect(imported.getVideoFrame).toHaveBeenCalledTimes(2);
    // Each consumer got a distinct VideoFrame instance.
    expect((onFrameA.mock.calls[0][0] as SharedTextureConsumerFrameLike).videoFrame).toBe(frameA);
    expect((onFrameB.mock.calls[0][0] as SharedTextureConsumerFrameLike).videoFrame).toBe(frameB);
    expect(frameA.close).toHaveBeenCalledTimes(1);
    expect(frameB.close).toHaveBeenCalledTimes(1);
    // Imported texture is released exactly once after all consumers finish.
    await flush();
    expect(imported.release).toHaveBeenCalledTimes(1);

    regA.dispose();
    regB.dispose();
  });

  it("releases only after every consumer's async onFrame has settled", async () => {
    const { bound, deliver } = setup();
    const releaseGate: (() => void)[] = [];
    const gate = new Promise<void>((resolve) => {
      releaseGate.push(resolve);
    });
    const reg = bound.consume({ onFrame: () => gate });

    const imported = makeMockImported();
    const delivered = deliver(makeMockData(imported));
    await flush();
    expect(imported.release).not.toHaveBeenCalled();

    for (const open of releaseGate) open();
    await delivered;
    await flush();
    expect(imported.release).toHaveBeenCalledTimes(1);

    reg.dispose();
  });

  it("consumers on different bindings do not see each other's frames", async () => {
    const a = setup();
    const b = setup();
    const onFrameA = vi.fn();
    const onFrameB = vi.fn();
    a.bound.consume({ onFrame: onFrameA });
    b.bound.consume({ onFrame: onFrameB });

    await a.deliver(makeMockData());
    expect(onFrameA).toHaveBeenCalledTimes(1);
    expect(onFrameB).not.toHaveBeenCalled();

    a.bound.dispose();
    b.bound.dispose();
  });

  it("closes VideoFrame and releases the imported texture even when a handler throws", async () => {
    const { bound, deliver } = setup();
    const videoFrame = makeMockVideoFrame();
    const imported = makeMockImported(() => videoFrame);
    const onError = vi.fn();
    const reg = bound.consume({
      onFrame: () => {
        throw new Error("handler boom");
      },
      onError,
    });

    await deliver(makeMockData(imported));
    await flush();

    expect(videoFrame.close).toHaveBeenCalledTimes(1);
    expect(imported.release).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe("handler boom");

    reg.dispose();
  });

  it("closes VideoFrame and releases when an async handler rejects", async () => {
    const { bound, deliver } = setup();
    const videoFrame = makeMockVideoFrame();
    const imported = makeMockImported(() => videoFrame);
    const onError = vi.fn();
    const reg = bound.consume({
      onFrame: async () => {
        throw new Error("async boom");
      },
      onError,
    });

    await deliver(makeMockData(imported));
    await flush();

    expect(videoFrame.close).toHaveBeenCalledTimes(1);
    expect(imported.release).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe("async boom");

    reg.dispose();
  });

  it("tolerates a VideoFrame.close that throws (e.g. handler closed it first)", async () => {
    const { bound, deliver } = setup();
    const videoFrame = makeMockVideoFrame();
    (videoFrame.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("already closed");
    });
    const imported = makeMockImported(() => videoFrame);
    const reg = bound.consume({ onFrame: vi.fn() });

    await expect(deliver(makeMockData(imported))).resolves.toBeUndefined();
    await flush();
    expect(imported.release).toHaveBeenCalledTimes(1);

    reg.dispose();
  });

  it("one handler throwing does not prevent others from running or leaking release", async () => {
    const { bound, deliver } = setup();
    const onFrameBad = vi.fn(() => {
      throw new Error("bad");
    });
    const onFrameGood = vi.fn();
    const regBad = bound.consume({ onFrame: onFrameBad });
    const regGood = bound.consume({ onFrame: onFrameGood });

    const imported = makeMockImported();
    await deliver(makeMockData(imported));
    await flush();

    expect(onFrameBad).toHaveBeenCalledTimes(1);
    expect(onFrameGood).toHaveBeenCalledTimes(1);
    expect(imported.release).toHaveBeenCalledTimes(1);

    regBad.dispose();
    regGood.dispose();
  });

  it("disposing one consumer leaves others running", async () => {
    const { bound, deliver } = setup();
    const onFrameA = vi.fn();
    const onFrameB = vi.fn();
    const regA = bound.consume({ onFrame: onFrameA });
    const regB = bound.consume({ onFrame: onFrameB });

    regA.dispose();

    const imported = makeMockImported();
    await deliver(makeMockData(imported));
    await flush();

    expect(onFrameA).not.toHaveBeenCalled();
    expect(onFrameB).toHaveBeenCalledTimes(1);
    expect(imported.release).toHaveBeenCalledTimes(1);

    regB.dispose();
  });

  it("keeps the Electron slot bound after the last consumer disposes", () => {
    const { target, bound } = setup();
    const reg = bound.consume({ onFrame: vi.fn() });
    reg.dispose();

    // No swap, no uninstall. Only the dispatcher's internal entries are cleared.
    expect(target.setSharedTextureReceiver).toHaveBeenCalledTimes(1);
  });

  it("with no active consumers the installed receiver still drains incoming frames", async () => {
    const { bound, deliver } = setup();
    const onFrame = vi.fn();
    bound.consume({ onFrame }).dispose();

    const imported = makeMockImported();
    await deliver(makeMockData(imported));
    await flush();

    expect(onFrame).not.toHaveBeenCalled();
    expect(imported.release).toHaveBeenCalledTimes(1);
    expect(imported.getVideoFrame).not.toHaveBeenCalled();
  });

  it("registration dispose() is idempotent", () => {
    const { target, bound } = setup();
    const reg = bound.consume({ onFrame: vi.fn() });
    reg.dispose();
    reg.dispose();
    reg.dispose();
    expect(target.setSharedTextureReceiver).toHaveBeenCalledTimes(1);
  });

  it("a consumer calling imported.release() during onFrame does not crash the slot", async () => {
    // Simulate a misbehaving consumer that double-releases on its own. The
    // bound receiver's deferred release must tolerate this so subsequent
    // frames still reach healthy consumers.
    const { bound, deliver } = setup();
    const healthyOnFrame = vi.fn();
    const misbehavingImported = makeMockImported();
    // When the first release() is called by the consumer, flag the imported so
    // the second release() (from the bound receiver's finally) throws.
    let firstCallHandled = false;
    misbehavingImported.release.mockImplementation(() => {
      if (firstCallHandled) {
        throw new Error("already released");
      }
      firstCallHandled = true;
    });

    const misbehaving = bound.consume({
      onFrame: (_frame) => {
        // Consumer does the bad thing: releases the imported texture itself.
        misbehavingImported.release();
      },
    });
    const healthy = bound.consume({ onFrame: healthyOnFrame });

    // First frame uses the misbehaving imported. The outer release() will
    // throw, but must be swallowed.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(deliver(makeMockData(misbehavingImported))).resolves.toBeUndefined();
    // The outer release is deferred by one macrotask; flush to let it (and its
    // swallowed throw) fire.
    await flush();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();

    // A subsequent frame with a well-behaved imported still reaches consumers.
    const cleanImported = makeMockImported();
    await deliver(makeMockData(cleanImported));
    await flush();
    expect(healthyOnFrame).toHaveBeenCalledTimes(2); // called on both frames
    expect(cleanImported.release).toHaveBeenCalledTimes(1);

    misbehaving.dispose();
    healthy.dispose();
  });

  it("an onError handler that throws does not break release or other consumers", async () => {
    const { bound, deliver } = setup();
    const otherConsumer = vi.fn();
    const reg1 = bound.consume({
      onFrame: () => {
        throw new Error("first-consumer boom");
      },
      onError: () => {
        throw new Error("onError-itself-threw");
      },
    });
    const reg2 = bound.consume({ onFrame: otherConsumer });

    const videoFrame = makeMockVideoFrame();
    const imported = makeMockImported(() => videoFrame);

    // The onError throw must be swallowed so finally + outer release still run.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(deliver(makeMockData(imported))).resolves.toBeUndefined();
    await flush();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();

    // Other consumer still got its frame.
    expect(otherConsumer).toHaveBeenCalledTimes(1);
    // Release + close still ran (the mock hands the same frame to both
    // consumers, so it is closed once per consumer).
    expect(videoFrame.close).toHaveBeenCalledTimes(2);
    expect(imported.release).toHaveBeenCalledTimes(1);

    reg1.dispose();
    reg2.dispose();
  });

  it("a consumer disposed during its own onFrame is skipped on the next frame", async () => {
    const { bound, deliver } = setup();
    const onFrameA = vi.fn();
    const onFrameB = vi.fn();
    const registrations: { dispose(): void }[] = [];

    registrations.push(
      bound.consume({
        onFrame: (frame, ...args) => {
          onFrameA(frame, ...args);
          for (const reg of registrations) reg.dispose();
        },
      }),
    );
    const regB = bound.consume({ onFrame: onFrameB });

    await deliver(makeMockData(makeMockImported()));
    // Both fire on the first frame (A disposed itself at the end, but was
    // already in this frame's snapshot).
    expect(onFrameA).toHaveBeenCalledTimes(1);
    expect(onFrameB).toHaveBeenCalledTimes(1);

    onFrameA.mockClear();
    onFrameB.mockClear();
    await deliver(makeMockData(makeMockImported()));
    // Next frame: only B.
    expect(onFrameA).not.toHaveBeenCalled();
    expect(onFrameB).toHaveBeenCalledTimes(1);

    regB.dispose();
  });
});
