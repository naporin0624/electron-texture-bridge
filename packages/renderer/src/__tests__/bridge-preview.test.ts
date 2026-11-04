import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isReady: () => true },
  BrowserWindow: class MockBrowserWindow {
    setSize = vi.fn();
    webContents = { on: vi.fn(), setFrameRate: vi.fn() };
    isDestroyed(): boolean {
      return false;
    }
    destroy = vi.fn();
  },
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
}));

vi.mock("@napolab/texture-bridge-core", () => ({
  TextureSender: class MockTextureSender {
    stop = vi.fn();
    setPreview = vi.fn();
  },
  sendTextureFromPaintEvent: vi.fn(),
}));

vi.mock("@napolab/texture-bridge-core/electron", () => ({
  forwardSharedTexture: vi.fn(async () => undefined),
}));

import { TextureBridgeImpl } from "../bridge";
import { PREVIEW_FRAME_CHANNEL } from "../client/preview-protocol";
import { BrowserWindow } from "electron";
import { TextureSender } from "@napolab/texture-bridge-core";
import type { PreviewFrame } from "@napolab/texture-bridge-core";
import type { ForwardStatus, ForwardStatusEvent, TextureBridgeOptions } from "../types";

type Sender = InstanceType<typeof TextureSender>;
type PreviewCallback = (frame: PreviewFrame) => void;

const baseOpts: TextureBridgeOptions = {
  name: "test",
  width: 1920,
  height: 1080,
  rendererUrl: "file:///renderer.html",
};

interface TargetStub {
  readonly wc: Electron.WebContents;
  readonly send: ReturnType<typeof vi.fn>;
  readonly destroy: () => void;
}

const makeTarget = (): TargetStub => {
  const state = { destroyed: false };
  const send = vi.fn();
  const emitter = Object.assign(new EventEmitter(), {
    isDestroyed: () => state.destroyed,
    send,
  });
  const wc: unknown = emitter;
  return {
    wc: wc as Electron.WebContents,
    send,
    destroy: () => {
      state.destroyed = true;
      emitter.emit("destroyed");
    },
  };
};

const setPreviewOf = (sender: Sender): ReturnType<typeof vi.fn> =>
  vi.mocked(sender.setPreview) as unknown as ReturnType<typeof vi.fn>;

/** The callback handed to the most recent enabling `setPreview` call. */
const lastPreviewCallback = (sender: Sender): PreviewCallback => {
  const calls = setPreviewOf(sender).mock.calls;
  const enabling = calls.filter((c) => typeof c[2] === "function");
  const last = enabling[enabling.length - 1];
  if (!last) throw new Error("setPreview was never enabled");
  return last[2] as PreviewCallback;
};

const makeFrame = (width = 4, height = 2): PreviewFrame => ({
  width,
  height,
  data: Buffer.alloc(width * height * 4, 7),
});

const makeBridge = (sender: Sender = new TextureSender("t", 1920, 1080)) =>
  new TextureBridgeImpl(new BrowserWindow(), sender, null, baseOpts);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TextureBridgeImpl.forwardPreviewFrames", () => {
  it("enables the native preview tap with the requested bounds on first registration", () => {
    const sender = new TextureSender("t", 1920, 1080);
    const bridge = makeBridge(sender);

    const forward = bridge.forwardPreviewFrames(makeTarget().wc, { width: 384, height: 216 });

    expect(forward.active).toBe(true);
    expect(setPreviewOf(sender)).toHaveBeenCalledTimes(1);
    expect(setPreviewOf(sender)).toHaveBeenCalledWith(384, 216, expect.any(Function));
  });

  it("sends each native preview frame to every target with its extraArgs", () => {
    const sender = new TextureSender("t", 1920, 1080);
    const bridge = makeBridge(sender);
    const a = makeTarget();
    const b = makeTarget();
    bridge.forwardPreviewFrames(a.wc, { width: 384, height: 216, extraArgs: ["P1"] });
    bridge.forwardPreviewFrames(b.wc, { width: 384, height: 216, extraArgs: ["P2", 9] });

    const frame = makeFrame();
    lastPreviewCallback(sender)(frame);

    const message = { width: 4, height: 2, data: frame.data };
    expect(a.send).toHaveBeenCalledWith(PREVIEW_FRAME_CHANNEL, message, "P1");
    expect(b.send).toHaveBeenCalledWith(PREVIEW_FRAME_CHANNEL, message, "P2", 9);
  });

  it("keeps one native tap per bridge: the oldest registration's bounds win", () => {
    const sender = new TextureSender("t", 1920, 1080);
    const bridge = makeBridge(sender);
    const first = bridge.forwardPreviewFrames(makeTarget().wc, { width: 384, height: 216 });
    bridge.forwardPreviewFrames(makeTarget().wc, { width: 640, height: 360 });

    // The second registration does not reconfigure the tap.
    expect(setPreviewOf(sender)).toHaveBeenCalledTimes(1);

    first.dispose();
    expect(setPreviewOf(sender)).toHaveBeenLastCalledWith(640, 360, expect.any(Function));
  });

  it("disables the native tap when the last registration goes away", () => {
    const sender = new TextureSender("t", 1920, 1080);
    const bridge = makeBridge(sender);
    const target = makeTarget();
    const forward = bridge.forwardPreviewFrames(target.wc, { width: 384, height: 216 });

    forward.dispose();
    forward.dispose();

    expect(forward.active).toBe(false);
    expect(setPreviewOf(sender)).toHaveBeenLastCalledWith(0, 0, null);
    expect(setPreviewOf(sender)).toHaveBeenCalledTimes(2);
    expect(target.wc.listenerCount("destroyed")).toBe(0);
  });

  it("prunes a destroyed target and disables the tap once nobody is left", () => {
    const sender = new TextureSender("t", 1920, 1080);
    const bridge = makeBridge(sender);
    const target = makeTarget();
    const forward = bridge.forwardPreviewFrames(target.wc, { width: 384, height: 216 });

    target.destroy();

    expect(forward.active).toBe(false);
    expect(setPreviewOf(sender)).toHaveBeenLastCalledWith(0, 0, null);
  });

  it("reports ok once, not per frame, and send failures as transitions", () => {
    const sender = new TextureSender("t", 1920, 1080);
    const bridge = makeBridge(sender);
    const target = makeTarget();
    const statuses: ForwardStatus[] = [];
    const events: ForwardStatusEvent[] = [];
    bridge.on("forwardStatus", (e) => {
      events.push(e);
    });
    bridge.forwardPreviewFrames(target.wc, {
      width: 384,
      height: 216,
      extraArgs: ["P1"],
      onStatus: (s) => {
        statuses.push(s);
      },
    });
    const deliver = lastPreviewCallback(sender);

    deliver(makeFrame());
    deliver(makeFrame());
    const boom = new Error("could not clone");
    target.send.mockImplementation(() => {
      throw boom;
    });
    deliver(makeFrame());
    deliver(makeFrame());
    target.send.mockReset();
    deliver(makeFrame());

    expect(statuses).toEqual([
      { ok: true },
      { ok: false, reason: "send-failed", cause: boom },
      { ok: true },
    ]);
    expect(events.map((e) => e.extraArgs)).toEqual([["P1"], ["P1"], ["P1"]]);
  });

  it("reports preview-unavailable when the native tap cannot be set up, without emitting error", () => {
    const sender = new TextureSender("t", 1920, 1080);
    const failure = new Error("Failed to build the Metal preview pipeline");
    setPreviewOf(sender).mockImplementation(() => {
      throw failure;
    });
    const bridge = makeBridge(sender);
    const errors: Error[] = [];
    bridge.on("error", (e) => {
      errors.push(e);
    });
    const statuses: ForwardStatus[] = [];

    const forward = bridge.forwardPreviewFrames(makeTarget().wc, {
      width: 384,
      height: 216,
      onStatus: (s) => {
        statuses.push(s);
      },
    });

    // The registration itself is accepted — the tap is what is missing.
    expect(forward.active).toBe(true);
    expect(statuses).toEqual([{ ok: false, reason: "preview-unavailable", cause: failure }]);
    expect(errors).toEqual([]);
  });

  it("re-applies the tap to the sender rebuilt by resize()", () => {
    const senders: Sender[] = [];
    const createSender = (): Sender => {
      const s = new TextureSender("t", 1, 1);
      senders.push(s);
      return s;
    };
    const first = createSender();
    const bridge = new TextureBridgeImpl(
      new BrowserWindow(),
      first,
      null,
      baseOpts,
      "unit-scale",
      createSender,
    );
    const target = makeTarget();
    bridge.forwardPreviewFrames(target.wc, { width: 384, height: 216, extraArgs: [3] });

    bridge.resize(1280, 720);

    const rebuilt = senders[senders.length - 1];
    if (!rebuilt || rebuilt === first) throw new Error("resize did not rebuild the sender");
    expect(setPreviewOf(rebuilt)).toHaveBeenCalledWith(384, 216, expect.any(Function));
    lastPreviewCallback(rebuilt)(makeFrame());
    expect(target.send).toHaveBeenCalledWith(
      PREVIEW_FRAME_CHANNEL,
      expect.objectContaining({ width: 4, height: 2 }),
      3,
    );
  });

  it("drops frames that arrive after dispose and disables the tap before stopping", () => {
    const sender = new TextureSender("t", 1920, 1080);
    const bridge = makeBridge(sender);
    const target = makeTarget();
    const forward = bridge.forwardPreviewFrames(target.wc, { width: 384, height: 216 });
    const deliver = lastPreviewCallback(sender);

    bridge.dispose();
    deliver(makeFrame());

    expect(forward.active).toBe(false);
    expect(target.send).not.toHaveBeenCalled();
    const disableOrder = setPreviewOf(sender).mock.invocationCallOrder.at(-1) ?? 0;
    const stopOrder = vi.mocked(sender.stop).mock.invocationCallOrder.at(-1) ?? 0;
    expect(setPreviewOf(sender)).toHaveBeenLastCalledWith(0, 0, null);
    expect(disableOrder).toBeLessThan(stopOrder);
    expect(target.wc.listenerCount("destroyed")).toBe(0);
  });

  it("returns an inert handle after dispose or for a destroyed target", () => {
    const sender = new TextureSender("t", 1920, 1080);
    const bridge = makeBridge(sender);
    const dead = makeTarget();
    dead.destroy();

    expect(bridge.forwardPreviewFrames(dead.wc, { width: 384, height: 216 }).active).toBe(false);
    bridge.dispose();
    const late = bridge.forwardPreviewFrames(makeTarget().wc, { width: 384, height: 216 });

    expect(late.active).toBe(false);
    late.dispose();
    expect(setPreviewOf(sender)).not.toHaveBeenCalledWith(384, 216, expect.any(Function));
  });

  it("rejects non-positive bounds with an inert handle", () => {
    const sender = new TextureSender("t", 1920, 1080);
    const bridge = makeBridge(sender);

    expect(bridge.forwardPreviewFrames(makeTarget().wc, { width: 0, height: 216 }).active).toBe(
      false,
    );
    expect(setPreviewOf(sender)).not.toHaveBeenCalled();
  });

  it("settles target-destroyed for a target that dies between frames", () => {
    const sender = new TextureSender("t", 1920, 1080);
    const bridge = makeBridge(sender);
    const statuses: ForwardStatus[] = [];
    const target = makeTarget();
    // A target whose isDestroyed() flips without the "destroyed" event having
    // fired yet (Electron emits it asynchronously).
    const state = { dead: false };
    Object.assign(target.wc, { isDestroyed: () => state.dead });
    bridge.forwardPreviewFrames(target.wc, {
      width: 384,
      height: 216,
      onStatus: (s) => {
        statuses.push(s);
      },
    });

    state.dead = true;
    lastPreviewCallback(sender)(makeFrame());

    expect(target.send).not.toHaveBeenCalled();
    expect(statuses).toEqual([{ ok: false, reason: "target-destroyed" }]);
  });

  it("isolates a throwing onStatus observer from delivery", () => {
    const sender = new TextureSender("t", 1920, 1080);
    const bridge = makeBridge(sender);
    const target = makeTarget();
    vi.spyOn(console, "error").mockImplementation(() => {});
    bridge.forwardPreviewFrames(target.wc, {
      width: 384,
      height: 216,
      onStatus: () => {
        throw new Error("observer bug");
      },
    });

    expect(() => lastPreviewCallback(sender)(makeFrame())).not.toThrow();
    expect(target.send).toHaveBeenCalledTimes(1);
  });
});
