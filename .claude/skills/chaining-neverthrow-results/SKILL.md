---
name: chaining-neverthrow-results
description: Use when composing or chaining neverthrow Result / ResultAsync values — sequencing multi-step operations where each step can fail, recovering from a specific error, or deciding where to turn a Result into a plain value or HTTP response. Also when reaching for .match mid-pipeline, _unsafeUnwrap, isErr()+.value unwrapping, safeTry / yield*, or a try/catch around Result-returning code.
---

# Chaining neverthrow Results

## Overview

Once a value is a `Result`/`ResultAsync`, **keep it one.** Compose every step with combinators (`.andThen / .map / .mapErr / .orElse / .andTee`) and call `.match` exactly once, at the consumption edge, to turn the chain into the outside-world value (HTTP response, CLI exit, rendered output). The error channel stays a typed union the whole way; `.match` is where — and the only place where — it collapses.

This generalizes the route-boundary rule. **RELATED:** `backend-typescript-roadmap` owns the route specifics (`ApplicationError` union, `err.statusCode satisfies ContentfulStatusCode`); `precise-type-modeling` owns the error union itself.

## The combinators (the whole vocabulary)

| Combinator | Use for |
|---|---|
| `.andThen(fn)` | Next step that can itself fail (returns a `Result`/`ResultAsync`). Short-circuits on error. |
| `.map(fn)` | Transform the success value (cannot fail). |
| `.mapErr(fn)` | Normalize the error — e.g. into the shared `ApplicationError` union so the final `.match` is exhaustive. |
| `.orElse(fn)` | **Recover** from an error: return `okAsync(fallback)` for the case you handle, `errAsync(e)` to re-propagate the rest. |
| `.andTee(fn)` | Fire a side-effect (notify, log) without changing the value. |
| `.asyncAndThen(fn)` | Bridge a **sync** `Result` into an async chain (the first async step). |
| `fromPromise(p, e => new XError(...))` | Bring a throwing promise into the chain — the one place a throw is caught. |
| `Result.fromThrowable(fn, e => new XError(...))` | Bring a throwing **sync** function into the chain. **Bind it once to a named const** — `const safeFn = Result.fromThrowable(fn, wrap)` (arguments are forwarded), module scope when `fn` takes its dependencies as arguments, a local const otherwise. Never call it inline as `Result.fromThrowable(...)()` — that is the banned IIFE shape (see functional-programming rules). |

## The recipe

```ts
import { errAsync, okAsync, type ResultAsync } from "neverthrow";

// Each step returns a Result / ResultAsync. Build ONE chain; never unwrap mid-flow.
function run(raw: unknown): ResultAsync<Done, AppError> {
  return parse(raw) // Result<Input, AppError>
    .asyncAndThen((input) => load(input.id).map((record) => ({ input, record }))) // sync → async
    .andThen(({ input, record }) =>
      act(record, input).orElse((e) =>
        e.code === "recoverable" ? okAsync(fallback) : errAsync(e), // recover one case, re-propagate the rest
      ),
    )
    .andTee(() => notify()) // side-effect, value untouched
    .andThen((done) => save(done).map(() => done)); // thread `done` past a void step
}
```

Consume once, at the edge — the only `.match`:

```ts
function handle(raw: unknown): Promise<Response> {
  return run(raw).match(
    (done) => ({ status: 200, body: done }),
    (err) => ({ status: err.statusCode, body: { error: err.error } }),
  );
}
```

## Where the edge is

`.match` belongs only where the Result leaves your code for the outside world: the Hono route handler, a CLI `main`, a top-level effect, or a test assertion (tests may also use `isOk()/isErr()`). Service/domain/helper layers return the `ResultAsync` onward — they never `.match`.

## Anti-patterns

| Instead of | Do |
|---|---|
| `.match` mid-pipeline to branch then re-wrap in `ok`/`err` | `.andThen` (success path) / `.orElse` (recovery) |
| Recovering via `match(ok, err => …)` then `okAsync(...)` | `.orElse((e) => handled ? okAsync(x) : errAsync(e))` |
| `_unsafeUnwrap()` / `_unsafeUnwrapErr()` in production code | Carry the `Result`; collapse only at the edge with `.match` |
| `if (r.isErr()) return …; const v = r.value` mid-flow | `.andThen` (`isErr`/`.value` is for tests, not production flow) |
| `try { … } catch` around a Result-returning call | `fromPromise(p, e => new XError(...))`, then chain |
| `Result.fromThrowable(() => x.y(), wrap)()` — wrap-and-invoke inline (IIFE shape) | `const safeY = Result.fromThrowable((x) => x.y(), wrap);` once at module scope, then `safeY(x)` in the chain |
| `safeTry` + `yield*` generator do-notation | Chain with `.andThen` / `.orElse` — this is the project's style |

## Red Flags — STOP

- About to write `.match` somewhere that is not the consumption edge → use `.andThen`/`.orElse`.
- About to write `_unsafeUnwrap` / `_unsafeUnwrapErr` outside a test.
- About to `await` a Result and read `.value` / `.error` outside a test → keep chaining.
- About to `import { safeTry }` or `yield*` a Result → use combinators.
- A `try/catch` wrapping code that already returns a Result → wrap the throwing promise once with `fromPromise`.
- About to write `)()` right after `Result.fromThrowable(...)` → bind it to a named const first; forward arguments instead of closing over them.
