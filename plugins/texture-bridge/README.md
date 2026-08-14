# texture-bridge plugin

Claude Code skills for using [`@napolab/texture-bridge`](https://github.com/naporin0624/electron-texture-bridge) — zero-copy GPU texture sharing between Electron offscreen windows and VJ software (Syphon / Spout), plus renderer-to-renderer frame forwarding.

## Install

### Claude Code (plugin)

```
/plugin marketplace add naporin0624/electron-texture-bridge
/plugin install texture-bridge
```

### Any other agent (Skills CLI)

Works with Codex, GitHub Copilot, Amp, Cursor, Antigravity, and others via
[skills.sh](https://skills.sh/naporin0624/electron-texture-bridge). **Install one
skill per command** — passing several at once only installs the first:

```bash
npx skills add naporin0624/electron-texture-bridge@setting-up-texture-bridge
npx skills add naporin0624/electron-texture-bridge@choosing-texture-bridge-api
npx skills add naporin0624/electron-texture-bridge@migrating-to-forward-frames
npx skills add naporin0624/electron-texture-bridge@receiving-shared-textures
npx skills add naporin0624/electron-texture-bridge@managing-frame-forward-lifecycle
npx skills add naporin0624/electron-texture-bridge@delivering-imported-textures
npx skills add naporin0624/electron-texture-bridge@handling-texture-bridge-failures
npx skills add naporin0624/electron-texture-bridge@diagnosing-dead-frame-forwards
```

Add `-g` to install globally instead of into the current project.

> Omitting the `@skill-name` suffix installs **every** skill in the repository,
> including this project's own internal development-rule skills (`ci`,
> `smart-commit`, and others) that are not about texture-bridge at all. Name the
> skills you want.

## Skills

Skills activate automatically from conversation context — no commands to learn.

| Skill | Fires when you ask about |
|-------|--------------------------|
| `setting-up-texture-bridge` | Installing the library, adding Syphon/Spout output to an Electron app, electron-vite config, black/garbled output right after setup |
| `choosing-texture-bridge-api` | Which API tier to use — simple vs core, `forwardSharedTexture` vs `forwardFrames`, send vs receive paths — and integration-plan review |
| `migrating-to-forward-frames` | Replacing `capturePage` polling / bitmap-IPC previews / Syphon loopbacks with zero-copy forwarding |
| `receiving-shared-textures` | The receiving side: consuming forwarded frames, multiviewer grids, `VideoFrame` lifecycle, frames reappearing after disconnect |
| `managing-frame-forward-lifecycle` | Registering and tearing down `forwardFrames` targets: monitor windows that close and reopen, repeated connect/disconnect, `MaxListenersExceededWarning`, leaks around forwarding |
| `delivering-imported-textures` | Delivering a texture to a renderer from main: `importSharedTexture` / `sendSharedTexture` / `release()` by hand, where `release()` belongs, `sendImportedTexture` vs `forwardSharedTexture` |
| `handling-texture-bridge-failures` | Error handling and telemetry: which calls throw, reject, model a defect, or emit — what to wrap with `Result.fromThrowable`, silently black output, a main-process crash from a bridge call |
| `diagnosing-dead-frame-forwards` | A forwarded preview/monitor that went black, froze on its last frame, or shows "no signal" — dead previews with nothing in the logs, or only some targets dying while Syphon/Spout keeps working |

## Why these skills exist

Models asked to integrate this library without them consistently fabricate plausible-looking APIs (`publishSharedTexture`, `subscribeFrames`, options objects that don't exist). Each skill was written test-first against those observed failures and verified to make an agent produce the real API surface.

## Requirements

- Electron 40+ (`useSharedTexture` paint events)
- `@napolab/texture-bridge-renderer` (high-level) or `@napolab/texture-bridge-core` (low-level)
