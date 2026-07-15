import { describe, expect, it } from "vitest";
import {
  FrameReceiveError,
  ReceiverStoppedError,
  TextureDeliveryError,
  TextureImportError,
  UnsupportedPixelFormatError,
} from "../errors";

describe("renderer error classes", () => {
  it("carry stable name discriminators", () => {
    expect(new FrameReceiveError("x").name).toBe("FrameReceiveError");
    expect(new TextureImportError("x").name).toBe("TextureImportError");
    expect(new TextureDeliveryError("x").name).toBe("TextureDeliveryError");
    expect(new UnsupportedPixelFormatError("nv12", ["bgra"]).name).toBe(
      "UnsupportedPixelFormatError",
    );
    expect(new ReceiverStoppedError(10).name).toBe("ReceiverStoppedError");
  });

  it("are Error instances discriminable via instanceof", () => {
    const error: Error = new TextureImportError("boom");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(TextureImportError);
    expect(error instanceof TextureDeliveryError).toBe(false);
  });

  it("preserve the wrapped message and cause", () => {
    const cause = new Error("import failed badly");
    const wrapped = new TextureImportError(cause.message, { cause });
    expect(wrapped.message).toBe("import failed badly");
    expect(wrapped.cause).toBe(cause);
  });

  it("UnsupportedPixelFormatError formats the public message shape", () => {
    const error = new UnsupportedPixelFormatError("nv12", ["bgra", "rgba", "rgbaf16"]);
    expect(error.message).toBe(
      'shared texture frame has unsupported pixelFormat "nv12" (expected one of bgra, rgba, rgbaf16)',
    );
  });

  it("ReceiverStoppedError formats the circuit-breaker message shape", () => {
    expect(new ReceiverStoppedError(10).message).toBe(
      "shared texture receiver stopped after 10 consecutive errors",
    );
  });
});
