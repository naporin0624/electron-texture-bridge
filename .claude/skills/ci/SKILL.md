---
name: ci
description: This skill should be used when the user asks to "run CI locally", "ci check", "smoke test", "run ci", "ci smoke", "pre-push check", "verify before PR", "CI を実行", "ローカル CI", or wants to reproduce GitHub Actions CI workflow checks on the local machine.
disable-model-invocation: true
argument-hint: "[--skip-common] [--skip-native] [--skip-package]"
---

# Local CI Smoke Test

Reproduce the GitHub Actions CI pipeline locally. Detect the running platform and run the matching workflow steps.

## Execution

Run the bundled script from the project root:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/ci-smoke.sh" $ARGUMENTS
```

## Skip Flags

| Flag | Effect |
|------|--------|
| `--skip-common` | Skip lint, build, typecheck |
| `--skip-native` | Skip cargo test and native addon build |
| `--skip-package` | Skip electron-builder packaging and artifact verification |

## Workflow Overview

### Common Checks (all platforms)
1. `pnpm lint` — oxlint
2. `pnpm build:core` — compile core package
3. `pnpm build:renderer` — compile renderer package
4. `pnpm typecheck` — tsgo type checking

### macOS (Darwin)
Prerequisite: `vendor/Syphon.framework` must exist.
- cargo test → build:native → example typecheck → example build → electron-builder --dir --mac → verify Syphon.framework + .node addon in packaged app

### Windows (MINGW/MSYS/CYGWIN/Windows_NT)
Prerequisite: `vendor/Spout2/` must exist.
- cargo test → build:native → example typecheck → example build → electron-builder --dir --win → verify .node addon in packaged app

### Linux
Common checks only. Native build not supported.

## Error Handling

- Missing vendor SDK: prints setup instructions and exits with code 1
- Any step failure: `set -e` causes immediate abort
- Artifact verification: explicit error messages identify which file is missing
