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

  it("emits 'updated' event when started", () => {
    const handler = vi.fn();
    discovery.on("updated", handler);
    discovery.start(100);
    vi.advanceTimersByTime(100);

    expect(handler).toHaveBeenCalledWith([]);
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

  it("dispose() cleans up and removes listeners", () => {
    const handler = vi.fn();
    discovery.on("updated", handler);
    discovery.start(100);
    vi.advanceTimersByTime(100);

    discovery.dispose();
    vi.advanceTimersByTime(300);
    // Should have been called only once (before dispose)
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
