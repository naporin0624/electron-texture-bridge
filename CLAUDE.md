## project setup rules

- pnpm で setup すること
- pnpm fmt で pnpm oxlint, pnpm oxfmt --write を実行すること
- pnpm lint で pnpm oxlint, pnpm oxfmt --check を実行すること
- `@typescript/native-preview` を利用すること
- 実装をする前にライブラリについて知らないことがある時は context7, web で調査してから進めること。
- vitest を利用した TDD で実装すること
- husky で commit 時に lint, typecheck を実行すること
- 勝手に commit しないこと
- 実装は小さいタスクに分けて実装すること。実装が終わったら difit を起動して私に review 依頼すること
- review で繰り返し受けた内容は rules, skills にすることで永続化して
    - review の内容はまず memory に記憶して繰り返し指摘されるものは skills にすること
- electron app を起動したら必ず process kill すること
- user がやりたいことを @docs/task.md にかいていく


## coding rules

- あなたは実装計画、ステークホルダーである私に対して要件のブレがなくなるまで AskUserQuestion で質問することに努め、実装は subagent に任せること
- 関数は単一責任で実装すること
- 同時に命令が複数来た時は Task で優先順位をつけて subagent に実装を任せること

## ref repository

ここに書かれているリポジトリには gh コマンドで参照し、既存実装を参照する前に ref repository の内容を先に探すこと
issue, .claude/rules, skills やコードが参考になる。

<--- ここから --->
electron としてはこちらが参考になる
https://github.com/swanpute/request-invite-system/tree/main/packages/electron
https://github.com/naporin0624/Cannelloni
VJ システムとしてはこちらが参考になる
https://github.com/naporin0624/Genovese
<--- ここまで --->
## comment rules
- `<--- ここから --->` `<--- ここまで --->` と書かれている場合はその範囲は commit しないこと

## resources rules
- mockup 用の画像が必要な時は Codex CLI の組み込み画像生成スキル `$imagegen` を使うこと
- 使い方:
    - headless（推奨）: `codex exec "<生成したい画像の説明> $imagegen"`
    - 対話: `codex "<説明> $imagegen"`
    - 参照画像を渡す: `codex -i ref.png "<説明> $imagegen"` / `codex --image a.png,b.jpg "<説明>"`
- モデルは `gpt-image-2`。生成画像は `~/.codex/generated_images/`（`$CODEX_HOME/generated_images/`）に保存される
- 出力先パス・サイズ・品質・透過・枚数は プロンプト内に自然言語で指定する（`--out`/`--size` 等のフラグは不要）
- 用途: アイコン・バナー・イラスト・スプライト・プレースホルダ等のモックアップ素材


### Native Addon Build Prerequisites

**macOS:** Build Syphon.framework from the git submodule:
```bash
cd vendor/syphon-src
xcodebuild -project Syphon.xcodeproj -scheme Syphon -configuration Release \
  -derivedDataPath build ONLY_ACTIVE_ARCH=NO BUILD_LIBRARY_FOR_DISTRIBUTION=YES
cp -R build/Build/Products/Release/Syphon.framework ../Syphon.framework
```

**Windows:** Clone Spout2 SDK into vendor (directory structure must be preserved for relative includes):
```bash
git init _tmp
git -C _tmp remote add origin https://github.com/leadedge/Spout2.git
git -C _tmp fetch --depth 1 origin 6b68a5b4fdeca6130b851e5f9366467a844860e5
git -C _tmp checkout --detach FETCH_HEAD
mkdir -p vendor/Spout2
cp -r _tmp/SPOUTSDK/SpoutDirectX vendor/Spout2/SpoutDirectX
cp -r _tmp/SPOUTSDK/SpoutGL vendor/Spout2/SpoutGL
rm -rf _tmp
```

## Architecture: Data Flow

```
OffscreenBrowserWindow (useSharedTexture: true)
  → WebGL/Canvas rendering in Web Worker
  → paint event fires with textureInfo (IOSurface / NT Handle)
  → TextureSender.send() / sendSurface() — zero-copy GPU share
  → Syphon Server (macOS) or Spout Sender (Windows)
  → External VJ apps receive texture
```

The key insight: Electron 40's `sharedTexture` paint event provides a GPU texture handle directly — the native addon passes this handle to Syphon/Spout without ever reading pixels back to CPU.

## Native Addon Layering

```
JavaScript API (packages/native/src/lib.rs via napi-rs)
  → Platform module (src/mac/mod.rs or src/win/mod.rs)
    → FFI declarations (src/mac/ffi.rs or src/win/ffi.rs)
      → C++/ObjC++ bridge (cpp/mac/syphon_bridge.mm or cpp/win/spout_bridge.cpp)
        → Vendor SDK (Syphon.framework or SpoutDX)
```

`build.rs` resolves `vendor/` paths relative to workspace root (two directories up from `packages/native/Cargo.toml` via `CARGO_MANIFEST_DIR`). The `cpp/` directory is crate-root relative since Cargo sets CWD to `packages/native/`.

## Release (release-please)

- Uses `release-please` with `linked-versions` plugin — all three packages share the same version
- Config: `release-please-config.json`, manifest: `.release-please-manifest.json`
- **Path-based detection:** release-please only creates a release PR when Conventional Commits (`fix:`, `feat:`, etc.) touch files **inside** a configured package path (`packages/native/`, `packages/core/`, `packages/renderer/`). Changes to root-level files (`.github/workflows/ci.yml`, root `package.json`, etc.) are **ignored** and will not trigger a release PR.
- To trigger a release for CI-only or root-level fixes, make a change (e.g. bump comment or changelog entry) inside one of the package directories, or create the release PR manually.

## Workflow: Before Starting Implementation

Before writing any new code, check [`tasks.md`](tasks.md) for pending implementation plans. Each task links to a detailed plan document in `docs/superpowers/plans/`. If the work you're about to do is already planned there, follow the existing plan rather than designing from scratch.

