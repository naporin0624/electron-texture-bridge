/**
 * Normalize an unknown `catch` value into an `Error` instance. Non-Error
 * values are stringified into the message. Shared by every bridge that emits
 * `"error"` events from a `catch` block.
 */
export const toError = (value: unknown): Error => {
  if (value instanceof Error) return value;
  return new Error(`${value}`);
};
