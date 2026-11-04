import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { consumePreviewFrames } from "../client/preview-frame-consumer";
import { PREVIEW_FRAME_CHANNEL } from "../client/preview-protocol";

/** Minimal `ipcRenderer` shape: an EventEmitter whose listeners get `(event, ...args)`. */
const makeIpc = () => new EventEmitter();

const emitFrame = (ipc: EventEmitter, message: unknown, ...extraArgs: unknown[]): void => {
  ipc.emit(PREVIEW_FRAME_CHANNEL, { sender: null }, message, ...extraArgs);
};

const rgba = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(width * height * 4);
  bytes.forEach((_, i) => {
    bytes[i] = i % 256;
  });
  return bytes;
};

describe("consumePreviewFrames", () => {
  it("hands each frame to onFrame as an ImageData-ready view plus the extraArgs", () => {
    const ipc = makeIpc();
    const onFrame = vi.fn();
    consumePreviewFrames(ipc, { onFrame });

    const data = rgba(4, 2);
    emitFrame(ipc, { width: 4, height: 2, data }, "P1", 7);

    expect(onFrame).toHaveBeenCalledTimes(1);
    const [frame, ...extraArgs] = onFrame.mock.calls[0] ?? [];
    expect(extraArgs).toEqual(["P1", 7]);
    expect(frame.width).toBe(4);
    expect(frame.height).toBe(2);
    expect(frame.data).toBeInstanceOf(Uint8ClampedArray);
    // A view over the received bytes, not a copy.
    expect(frame.data.buffer).toBe(data.buffer);
    expect(frame.data.byteOffset).toBe(data.byteOffset);
    expect(Array.from(frame.data)).toEqual(Array.from(data));
  });

  it("keeps the view correct for a message that is a slice of a larger buffer", () => {
    const ipc = makeIpc();
    const onFrame = vi.fn();
    consumePreviewFrames(ipc, { onFrame });

    const backing = new Uint8Array(64);
    const data = backing.subarray(16, 16 + 2 * 2 * 4);
    data.fill(9);
    emitFrame(ipc, { width: 2, height: 2, data });

    const [frame] = onFrame.mock.calls[0] ?? [];
    expect(frame.data.byteOffset).toBe(16);
    expect(frame.data.length).toBe(16);
    expect(Array.from(frame.data)).toEqual(Array(16).fill(9));
  });

  it("reports malformed messages to onError and keeps listening", () => {
    const ipc = makeIpc();
    const onFrame = vi.fn();
    const onError = vi.fn();
    consumePreviewFrames(ipc, { onFrame, onError });

    emitFrame(ipc, { width: 4, height: 2, data: new Uint8Array(3) });
    emitFrame(ipc, "not a frame");
    emitFrame(ipc, { width: 1, height: 1, data: new Uint8Array(4) });

    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it("routes an onFrame throw to onError without breaking later frames", () => {
    const ipc = makeIpc();
    const boom = new Error("draw failed");
    const onFrame = vi.fn().mockImplementationOnce(() => {
      throw boom;
    });
    const onError = vi.fn();
    consumePreviewFrames(ipc, { onFrame, onError });

    emitFrame(ipc, { width: 1, height: 1, data: new Uint8Array(4) });
    emitFrame(ipc, { width: 1, height: 1, data: new Uint8Array(4) });

    expect(onError).toHaveBeenCalledWith(boom);
    expect(onFrame).toHaveBeenCalledTimes(2);
  });

  it("falls back to console.error when no onError is given", () => {
    const ipc = makeIpc();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    consumePreviewFrames(ipc, {
      onFrame: () => {
        throw new Error("x");
      },
    });

    expect(() => emitFrame(ipc, { width: 1, height: 1, data: new Uint8Array(4) })).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("stops delivering and removes its listener on dispose, idempotently", () => {
    const ipc = makeIpc();
    const onFrame = vi.fn();
    const registration = consumePreviewFrames(ipc, { onFrame });

    registration.dispose();
    registration.dispose();
    emitFrame(ipc, { width: 1, height: 1, data: new Uint8Array(4) });

    expect(onFrame).not.toHaveBeenCalled();
    expect(ipc.listenerCount(PREVIEW_FRAME_CHANNEL)).toBe(0);
  });

  it("lets several consumers share one ipc source independently", () => {
    const ipc = makeIpc();
    const a = vi.fn();
    const b = vi.fn();
    const ra = consumePreviewFrames(ipc, { onFrame: a });
    consumePreviewFrames(ipc, { onFrame: b });

    ra.dispose();
    emitFrame(ipc, { width: 1, height: 1, data: new Uint8Array(4) });

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
