import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextureInfo } from "@napolab/texture-bridge-core";

// -- electron mock ----------------------------------------------------------
//
// PreviewManager talks to `BrowserWindow`, `ipcMain`, and `sharedTexture`.
// We stub all three so the module can be imported under vitest's node
// environment (no real Electron runtime) — same approach as bridge.test.ts.

const mockImportSharedTexture = vi.fn();
const mockSendSharedTexture = vi.fn();
const mockIpcMainOn = vi.fn();
const mockIpcMainRemoveListener = vi.fn();
const mockBrowserWindowCtor = vi.fn();

vi.mock("electron", () => {
  let nextWebContentsId = 1;

  class MockBrowserWindow {
    webContents: { id: number; mainFrame: unknown };
    loadFile = vi.fn();
    close = vi.fn(() => {
      this._destroyed = true;
    });
    private _destroyed = false;
    private closedListeners: Array<() => void> = [];

    constructor(options: unknown) {
      mockBrowserWindowCtor(options);
      this.webContents = { id: nextWebContentsId++, mainFrame: { marker: "main-frame" } };
    }

    isDestroyed(): boolean {
      return this._destroyed;
    }

    on(event: string, listener: () => void): void {
      if (event === "closed") this.closedListeners.push(listener);
    }
  }

  return {
    BrowserWindow: MockBrowserWindow,
    ipcMain: {
      on: (event: string, listener: (event: { sender: { id: number } }) => void) =>
        mockIpcMainOn(event, listener),
      removeListener: (event: string, listener: unknown) =>
        mockIpcMainRemoveListener(event, listener),
    },
    sharedTexture: {
      importSharedTexture: (opts: unknown) => mockImportSharedTexture(opts),
      sendSharedTexture: (opts: unknown) => mockSendSharedTexture(opts),
    },
  };
});

import { PreviewManager } from "../preview-manager";

const flushPromises = async () => {
  for (const _ of Array.from({ length: 10 })) {
    await Promise.resolve();
  }
};

const makeTextureInfo = (): TextureInfo => ({
  pixelFormat: "bgra",
  codedSize: { width: 1920, height: 1080 },
  visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
  handle: {},
});

/** Open the manager and simulate the renderer's `preview-ready` IPC ack. */
const openReadyManager = (): PreviewManager => {
  const manager = new PreviewManager(1920, 1080);
  manager.open();

  const win = manager.window;
  if (!win) throw new Error("expected window to be open");

  const call = mockIpcMainOn.mock.calls.at(-1) as
    | [string, (event: { sender: { id: number } }) => void]
    | undefined;
  if (!call) throw new Error("expected a preview-ready listener to be registered");
  call[1]({ sender: { id: win.webContents.id } });

  return manager;
};

describe("PreviewManager.sendFrame", () => {
  const mockImported = { release: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockImportSharedTexture.mockReturnValue(mockImported);
    mockSendSharedTexture.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("swallows a synchronous throw from importSharedTexture", () => {
    mockImportSharedTexture.mockImplementation(() => {
      throw new Error("import boom");
    });

    const manager = openReadyManager();

    expect(() => manager.sendFrame({ textureInfo: makeTextureInfo() })).not.toThrow();
    expect(mockSendSharedTexture).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("swallows a synchronous throw from sendSharedTexture after a successful import", async () => {
    mockImportSharedTexture.mockReturnValue(mockImported);
    mockSendSharedTexture.mockImplementation(() => {
      throw new Error("send boom");
    });

    const manager = openReadyManager();

    expect(() => manager.sendFrame({ textureInfo: makeTextureInfo() })).not.toThrow();
    await flushPromises();

    manager.dispose();
  });

  it("silently skips when importSharedTexture returns a falsy value", async () => {
    mockImportSharedTexture.mockReturnValue(undefined);

    const manager = openReadyManager();

    expect(() => manager.sendFrame({ textureInfo: makeTextureInfo() })).not.toThrow();
    await flushPromises();
    expect(mockSendSharedTexture).not.toHaveBeenCalled();

    manager.dispose();
  });

  it("happy path: imports, sends to the preview window, then releases the texture", async () => {
    mockImportSharedTexture.mockReturnValue(mockImported);
    mockSendSharedTexture.mockResolvedValue(undefined);

    const manager = openReadyManager();
    const win = manager.window;
    if (!win) throw new Error("expected window to be open");

    manager.sendFrame({ textureInfo: makeTextureInfo() });
    await flushPromises();

    expect(mockSendSharedTexture).toHaveBeenCalledTimes(1);
    const sendArg = mockSendSharedTexture.mock.calls[0][0] as {
      frame: unknown;
      importedSharedTexture: unknown;
    };
    expect(sendArg.frame).toBe(win.webContents.mainFrame);
    expect(sendArg.importedSharedTexture).toBe(mockImported);
    expect(mockImported.release).toHaveBeenCalledTimes(1);

    manager.dispose();
  });
});

describe("PreviewManager window setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the preview with an isolated, non-sandboxed preload (preload requires the client bundle)", () => {
    const manager = new PreviewManager(1920, 1080);
    manager.open();

    expect(mockBrowserWindowCtor).toHaveBeenCalledTimes(1);
    const [options] = mockBrowserWindowCtor.mock.calls[0] as [
      { webPreferences: Record<string, unknown> },
    ];
    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    });
    expect(`${options.webPreferences.preload}`).toMatch(/[\\/]assets[\\/]preview-preload\.js$/);

    manager.dispose();
  });

  it("loads preview.html with the canvas size query", () => {
    const manager = new PreviewManager(1280, 720);
    manager.open();

    const win = manager.window;
    if (!win) throw new Error("expected window to be open");
    expect(win.loadFile).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]assets[\\/]preview\.html$/),
      { query: { w: "1280", h: "720" } },
    );

    manager.dispose();
  });

  it("updateSize reloads preview.html with the new size (the preload rebinds on reload)", () => {
    const manager = new PreviewManager(1920, 1080);
    manager.open();

    const win = manager.window;
    if (!win) throw new Error("expected window to be open");
    manager.updateSize(640, 480);

    expect(win.loadFile).toHaveBeenLastCalledWith(
      expect.stringMatching(/[\\/]assets[\\/]preview\.html$/),
      { query: { w: "640", h: "480" } },
    );

    manager.dispose();
  });
});
