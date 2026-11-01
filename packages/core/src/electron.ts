/**
 * Electron-coupled forwarding primitive — deliberately a SEPARATE subpath
 * (`@napolab/texture-bridge-core/electron`). The package's main entry must
 * stay importable without Electron (the plain-Node `sendRgbaBuffer` sanity
 * check depends on it); the static `electron` import below is quarantined
 * here and enforced by scripts/electron-free-guard.mjs at build time.
 */
import { sharedTexture, type WebContents } from "electron";
import { Result, ResultAsync } from "neverthrow";
import type { TextureInfo } from "./types";

/**
 * Why a frame could not be forwarded. A modeled outcome, not an error —
 * mirrors `sendTextureFromPaintEvent`'s `PaintDefect | undefined` contract:
 * the low-level tier reports, the caller decides.
 */
export type ForwardDefect =
  | { readonly reason: "target-destroyed" }
  | { readonly reason: "import-failed"; readonly cause: Error }
  | { readonly reason: "send-failed"; readonly cause: Error };

const toCauseError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(`${value}`, { cause: value });

const safeImportSharedTexture = Result.fromThrowable(
  (textureInfo: TextureInfo) => sharedTexture.importSharedTexture({ textureInfo }),
  toCauseError,
);

/**
 * Deliver an imported shared texture to a frame, releasing the import in all
 * outcomes. Declared at module scope so its dependencies are explicit
 * arguments — no inner function declarations. Invoking an async function
 * never throws synchronously (a throw inside becomes a promise rejection
 * instead), so callers can hand `sendImportedTexture(...)` straight to
 * `ResultAsync.fromPromise` and both sync throws and rejections from
 * `sendSharedTexture` funnel into the error channel.
 *
 * Exported so both `forwardSharedTexture` (below) and the renderer package's
 * `shared-texture-receiver.ts` / `preview-manager.ts` share one
 * implementation instead of maintaining duplicate deliver-and-release logic.
 */
export const sendImportedTexture = async (
  frame: NonNullable<WebContents["mainFrame"]>,
  imported: ReturnType<typeof sharedTexture.importSharedTexture>,
  extraArgs: readonly unknown[] = [],
): Promise<void> => {
  try {
    await sharedTexture.sendSharedTexture({ frame, importedSharedTexture: imported }, ...extraArgs);
  } finally {
    imported.release();
  }
};

/**
 * Forward one paint frame to a renderer `WebContents` via Electron's
 * shared-texture channel (`importSharedTexture` → `sendSharedTexture`).
 * Zero-copy: only a GPU handle crosses process boundaries.
 *
 * Returns `undefined` when the frame was handed to Electron for delivery, or
 * a {@link ForwardDefect} describing why it was not. Never throws
 * synchronously (async function), and never swallows: callers own the
 * decision to log, count, or ignore. The renderer receives the frame through
 * `bindSharedTextureReceiver(sharedTexture).consume(...)` (from
 * `@napolab/texture-bridge-renderer/client`), with `extraArgs` forwarded
 * verbatim to the consumer handler.
 */
export const forwardSharedTexture = async (
  textureInfo: TextureInfo,
  target: WebContents,
  extraArgs: readonly unknown[] = [],
): Promise<ForwardDefect | undefined> => {
  if (target.isDestroyed()) return { reason: "target-destroyed" };
  const frame = target.mainFrame;
  if (!frame) return { reason: "target-destroyed" };

  return safeImportSharedTexture(textureInfo)
    .mapErr((cause): ForwardDefect => ({ reason: "import-failed", cause }))
    .asyncAndThen((imported) =>
      ResultAsync.fromPromise(
        sendImportedTexture(frame, imported, extraArgs),
        (cause): ForwardDefect => ({ reason: "send-failed", cause: toCauseError(cause) }),
      ),
    )
    .match(
      () => undefined,
      (defect) => defect,
    );
};
