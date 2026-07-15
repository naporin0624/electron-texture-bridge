/**
 * Error classes for the core package's error channel (see
 * .claude/skills/modeling-errors-as-classes). `name` is a stable wire/log
 * discriminator; in-process discrimination uses `instanceof`.
 */

/** The native sender's `send()` / `sendSurface()` threw. */
export class TextureSendError extends Error {
  override name = "TextureSendError";
}
