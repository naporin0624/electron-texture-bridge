import { describe, expect, it } from "vitest";
import { toError } from "../to-error";

describe("toError", () => {
  it("returns Error instances unchanged", () => {
    const error = new Error("boom");
    expect(toError(error)).toBe(error);
  });

  it("returns Error subclasses unchanged", () => {
    const error = new TypeError("bad type");
    expect(toError(error)).toBe(error);
  });

  it("wraps a string into an Error with the string as message", () => {
    expect(toError("boom").message).toBe("boom");
  });

  it("wraps non-string primitives via stringification", () => {
    expect(toError(42).message).toBe("42");
    expect(toError(undefined).message).toBe("undefined");
    expect(toError(null).message).toBe("null");
  });

  it("preserves the original non-Error value on Error.cause", () => {
    expect(toError("boom").cause).toBe("boom");
    expect(toError(42).cause).toBe(42);
    const thrown = { code: "EFAIL" };
    expect(toError(thrown).cause).toBe(thrown);
  });
});
