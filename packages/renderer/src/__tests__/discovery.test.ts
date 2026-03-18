import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@napolab/texture-bridge-core", () => ({
  listSenders: vi.fn().mockReturnValue([]),
}));

import { listSenders } from "@napolab/texture-bridge-core";
const mockListSenders = vi.mocked(listSenders);

// Will be implemented
import { SenderDiscovery } from "../discovery";

describe("SenderDiscovery", () => {
  let discovery: SenderDiscovery;

  beforeEach(() => {
    vi.useFakeTimers();
    mockListSenders.mockReturnValue([]);
    discovery = new SenderDiscovery();
  });

  afterEach(() => {
    discovery.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not emit 'updated' when sender list is unchanged", () => {
    const handler = vi.fn();
    discovery.on("updated", handler);
    discovery.start(100);

    // First poll: empty → empty, no change
    vi.advanceTimersByTime(100);
    expect(handler).toHaveBeenCalledTimes(0);

    // Second poll: still empty, still no change
    vi.advanceTimersByTime(100);
    expect(handler).toHaveBeenCalledTimes(0);

    // Third poll: sender appears — this IS a change
    mockListSenders.mockReturnValue([{ name: "VJ", appName: "Resolume", uuid: "abc" }]);
    vi.advanceTimersByTime(100);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith([{ name: "VJ", appName: "Resolume", uuid: "abc" }]);
  });

  it("emits 'added' event when a new sender appears", () => {
    const handler = vi.fn();
    discovery.on("added", handler);
    discovery.start(100);

    // First poll: empty
    vi.advanceTimersByTime(100);

    // Second poll: new sender
    mockListSenders.mockReturnValue([{ name: "VJ", appName: "Resolume", uuid: "abc" }]);
    vi.advanceTimersByTime(100);

    expect(handler).toHaveBeenCalledWith([{ name: "VJ", appName: "Resolume", uuid: "abc" }]);
  });

  it("emits 'removed' event when a sender disappears", () => {
    const handler = vi.fn();
    discovery.on("removed", handler);

    // Start with one sender
    mockListSenders.mockReturnValue([{ name: "VJ", appName: "Resolume", uuid: "abc" }]);
    discovery.start(100);
    vi.advanceTimersByTime(100);

    // Sender disappears
    mockListSenders.mockReturnValue([]);
    vi.advanceTimersByTime(100);

    expect(handler).toHaveBeenCalledWith([{ name: "VJ", appName: "Resolume", uuid: "abc" }]);
  });

  it("getSenders returns the current list", () => {
    mockListSenders.mockReturnValue([{ name: "A" }]);
    discovery.start(100);
    vi.advanceTimersByTime(100);

    const senders = discovery.getSenders();
    expect(senders).toEqual([{ name: "A" }]);
  });

  it("stop() halts polling", () => {
    discovery.start(100);
    vi.advanceTimersByTime(100);
    expect(mockListSenders).toHaveBeenCalledTimes(1);

    discovery.stop();
    vi.advanceTimersByTime(300);
    expect(mockListSenders).toHaveBeenCalledTimes(1);
  });

  it("emits 'error' when listSenders throws", () => {
    const errorHandler = vi.fn();
    discovery.on("error", errorHandler);
    discovery.start(100);

    // listSenders throws on next poll
    mockListSenders.mockImplementation(() => {
      throw new Error("Native error");
    });
    vi.advanceTimersByTime(100);

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(errorHandler.mock.calls[0][0].message).toBe("Native error");
  });

  it("continues polling after error in listSenders", () => {
    const errorHandler = vi.fn();
    const updatedHandler = vi.fn();
    discovery.on("error", errorHandler);
    discovery.on("updated", updatedHandler);
    discovery.start(100);

    // First tick: throws
    mockListSenders.mockImplementation(() => {
      throw new Error("Transient error");
    });
    vi.advanceTimersByTime(100);
    expect(errorHandler).toHaveBeenCalledTimes(1);

    // Second tick: recovers
    mockListSenders.mockReturnValue([{ name: "VJ" }]);
    vi.advanceTimersByTime(100);
    expect(updatedHandler).toHaveBeenCalledTimes(1);
  });

  it("dispose() cleans up and removes listeners", () => {
    const addedHandler = vi.fn();
    discovery.on("added", addedHandler);
    discovery.start(100);

    // First tick with a sender
    mockListSenders.mockReturnValue([{ name: "VJ" }]);
    vi.advanceTimersByTime(100);
    expect(addedHandler).toHaveBeenCalledTimes(1);

    discovery.dispose();
    mockListSenders.mockReturnValue([{ name: "VJ" }, { name: "VJ2" }]);
    vi.advanceTimersByTime(300);
    // Should have been called only once (before dispose)
    expect(addedHandler).toHaveBeenCalledTimes(1);
  });
});
