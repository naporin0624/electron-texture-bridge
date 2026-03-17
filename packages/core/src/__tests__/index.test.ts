import { describe, expect, it, vi } from "vitest";

vi.mock("@napolab/texture-bridge", () => ({
  TextureSender: class MockTextureSender {},
  TextureReceiver: class MockTextureReceiver {},
  getPlatform: () => "mock-platform",
  listSenders: () => [{ name: "TestSender", appName: "TestApp", uuid: "test-uuid" }],
}));

describe("core re-exports", () => {
  it("re-exports TextureSender from native", async () => {
    const { TextureSender } = await import("../index");
    expect(TextureSender).toBeDefined();
  });

  it("re-exports TextureReceiver from native", async () => {
    const { TextureReceiver } = await import("../index");
    expect(TextureReceiver).toBeDefined();
  });

  it("re-exports listSenders from native", async () => {
    const { listSenders } = await import("../index");
    expect(listSenders).toBeDefined();
    expect(typeof listSenders).toBe("function");
  });

  it("re-exports getPlatform from native", async () => {
    const { getPlatform } = await import("../index");
    expect(getPlatform).toBeDefined();
    expect(typeof getPlatform).toBe("function");
  });

  it("re-exports sendTextureFromPaintEvent", async () => {
    const { sendTextureFromPaintEvent } = await import("../index");
    expect(sendTextureFromPaintEvent).toBeDefined();
    expect(typeof sendTextureFromPaintEvent).toBe("function");
  });

  it("exports SenderInfo type shape", async () => {
    const { listSenders } = await import("../index");
    const result = listSenders();
    expect(result[0]).toHaveProperty("name");
    expect(result[0]).toHaveProperty("appName");
    expect(result[0]).toHaveProperty("uuid");
  });
});
