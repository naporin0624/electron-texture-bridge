/**
 * Error classes for the renderer package's error channel (see
 * .claude/skills/modeling-errors-as-classes). `name` is a stable wire/log
 * discriminator; in-process discrimination uses `instanceof`. Errors that
 * wrap a caught value MUST preserve the original message
 * (`new XError(toError(cause).message, { cause })`) — the public error
 * events are asserted by message in the test suite.
 */

/** The native receiver's `receiveSharedTexture()` threw. */
export class FrameReceiveError extends Error {
  override name = "FrameReceiveError";
}

/** Electron's `importSharedTexture` threw before taking handle ownership. */
export class TextureImportError extends Error {
  override name = "TextureImportError";
}

/** Electron's `sendSharedTexture` rejected. */
export class TextureDeliveryError extends Error {
  override name = "TextureDeliveryError";
}

/** A frame arrived with a pixel format Electron cannot import. */
export class UnsupportedPixelFormatError extends Error {
  override name = "UnsupportedPixelFormatError";
  constructor(pixelFormat: string, expected: readonly string[]) {
    super(
      `shared texture frame has unsupported pixelFormat "${pixelFormat}" (expected one of ${expected.join(", ")})`,
    );
  }
}

/** Circuit breaker: too many consecutive tick errors; the receiver stopped itself. */
export class ReceiverStoppedError extends Error {
  override name = "ReceiverStoppedError";
  constructor(limit: number) {
    super(`shared texture receiver stopped after ${limit} consecutive errors`);
  }
}

/** Union of every failure the shared-texture send pipeline can produce. */
export type SendPipelineError =
  | UnsupportedPixelFormatError
  | TextureImportError
  | TextureDeliveryError;
