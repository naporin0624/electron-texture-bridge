---
name: consuming-results-at-api-boundaries
description: Use when exporting a function from a package that uses neverthrow internally, when tempted to export a safeX / xResult variant returning Result/ResultAsync, when asked to "provide" a fromThrowable-wrapped API to library users, or when deciding where a chain's final .match belongs.
---

# Consuming Results at API Boundaries

## Overview

**A package's public API boundary IS a consumption edge. `Result` / `ResultAsync` never appear in exported signatures — the outermost exported function calls `.match` itself and presents a conventional contract.**

This closes the gap in [[chaining-neverthrow-results]]: "one `.match` at the consumption edge" does NOT mean "leave the `.match` to the caller of your package." Anything that crosses `exports` in package.json leaves your code for the outside world — that is, by definition, the edge. neverthrow is an internal composition tool, not a public contract.

## The rule

| Surface | Error channel |
|---|---|
| Internal module ↔ internal module | Pass `Result` / `ResultAsync`, keep chaining ([[chaining-neverthrow-results]]) |
| **Exported function (sync)** | `.match` inside; ok → return value, err → `throw` a named error class |
| **Exported long-lived object** | `.match` inside; err → `emit("error", error)` / callback |
| **Exported error types** | Export the error **classes** ([[modeling-errors-as-classes]]) — never `Result` values, never `Result` in a public type |

## The recipe (real example from this repo — `packages/core`)

```ts
// ✅ Wrap once at module scope (arguments are forwarded — no IIFE-style
// `fromThrowable(...)()` immediate call), match once at the exported edge.
const safeDispatchSend = Result.fromThrowable(
  dispatchSend,                                             // internal throwing dispatch
  (cause) => new TextureSendError(cause instanceof Error ? cause.message : `${cause}`, { cause }),
);

export const sendTextureFromPaintEvent = (
  sender: InstanceType<typeof TextureSender>,
  textureInfo: TextureInfo | undefined,
): void => {
  if (!textureInfo) return;
  safeDispatchSend(sender, textureInfo).match(
    () => undefined,
    (error) => { throw error; },                            // conventional contract: void + typed throw
  );
};

export { TextureSendError };                                // classes yes, Results no
```

```ts
// ❌ What both baseline attempts produced — a Result in the public contract
export const safeEncode = (encoder: Encoder, buf: Buffer): Result<Buffer, EncodeError> => ...
export const safeFlush: () => Result<void, FlushError> = Result.fromThrowable(...);
```

Consumers get `instanceof TextureSendError`, the original message, and the thrown value on `Error.cause` — full fidelity, zero neverthrow coupling.

## Common rationalizations

| Excuse | Reality |
|---|---|
| "A library is never the consumption edge — only the caller knows their edge" | The package boundary is YOUR edge. The caller has their own edge for their own Results; yours must not become their dependency. |
| "Pre-matching collapses the typed error channel" | No — the channel survives as an exported error class discriminated with `instanceof`. Types collapse; fidelity doesn't. |
| "Declare neverthrow as a peerDependency and make Result part of the contract" | That forces every consumer onto one specific neverthrow major forever. Version skew breaks `instanceof Result` across duplicated installs. |
| "The user asked for the fromThrowable-wrapped version" | They asked for the throw to be handled via fromThrowable — do that internally. 「提供」= provide the *behavior*, not the `Result` object. |
| "An additive `safeX` export is non-breaking, so it's fine" | Additive or not, it leaks the internal composition style into the public contract. |

## Red flags — STOP

- An exported name like `safeX`, `xResult`, `tryX` whose return type mentions `Result` / `ResultAsync`.
- `neverthrow` appearing in `peerDependencies`, or in any exported `.d.ts` type.
- A JSDoc example telling consumers where to put *their* `.match` on *your* return value.
- Reasoning that contains "the library cannot know the caller's edge" — that sentence means you are about to leak a Result.

## When NOT to apply

- Inside the package: keep passing Results between internal modules; do not `.match` mid-pipeline.
- App code (not a published package): the edge is the route handler / CLI main / event emit, exactly as [[chaining-neverthrow-results]] says.
