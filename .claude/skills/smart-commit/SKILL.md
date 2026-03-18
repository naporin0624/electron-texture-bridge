---
name: smart-commit
description: This skill should be used when the user asks to "smart commit", "logical commit", "group commits", "分割コミット", "論理コミット", or wants to automatically analyze staged/unstaged changes and create logically grouped commits.
disable-model-invocation: true
argument-hint: "[--dry-run]"
---

# Smart Commit

Analyze all staged and unstaged changes, group them into logical commits, and create each commit with a descriptive Conventional Commits message.

## Procedure

### Step 1: Gather changes

Run these commands in parallel to collect the full picture:

```bash
git status
git diff
git diff --cached
git log --oneline -10
```

If there are no changes (no untracked files, no modifications, no staged changes), report "Nothing to commit" and stop.

### Step 2: Analyze and group (use Sonnet subagent)

Spawn an Agent with `model: "sonnet"` to analyze the diff output and propose logical commit groups. The subagent should:

- Read every changed file's diff carefully
- Group related changes by logical unit of work (feature, fix, refactor, chore, docs, test, ci, etc.)
- Each group should be independently meaningful — one group = one concern
- Order groups so dependencies come first (e.g., library changes before consumers)
- For each group, produce:
  - **Files**: list of file paths to include
  - **Message**: Conventional Commits format (`type(scope): description`)
  - **Why**: one-line rationale for the grouping

Grouping principles:
- Separate functional changes from formatting/style changes
- Separate production code from test code when they address different concerns
- Keep config/CI changes in their own group
- If a single file has changes belonging to multiple logical groups, note it but keep the file in the most relevant group (git stages whole files)

### Step 3: Present plan to user

Display the proposed commit groups as a numbered list:

```
Commit plan:

1. fix(core): correct platform handle extraction
   Files: packages/core/src/index.ts, packages/core/src/utils.ts
   Why: Fixes buffer reading for NT handle on Windows

2. feat(renderer): add FPS throttling option
   Files: packages/renderer/src/bridge.ts, packages/renderer/src/types.ts
   Why: New user-facing feature for frame rate control

3. chore(ci): update build matrix for macOS 14
   Files: .github/workflows/ci.yml
   Why: CI infrastructure change, independent of code
```

Ask the user to confirm, reorder, merge, split, or skip groups.

If `$ARGUMENTS` contains `--dry-run`, show the plan and stop without committing.

### Step 4: Execute commits

For each approved group, in order:

1. Stage only the files in that group: `git add <file1> <file2> ...`
2. Create the commit using a HEREDOC for the message:

```bash
git commit -m "$(cat <<'EOF'
type(scope): description

Co-Authored-By: Claude Sonnet <noreply@anthropic.com>
EOF
)"
```

3. Run `git status` after the final commit to confirm clean state.

## Rules

- NEVER use `git add -A` or `git add .` — always add specific files
- NEVER amend existing commits
- NEVER push to remote
- NEVER skip pre-commit hooks (no `--no-verify`)
- If a pre-commit hook fails, fix the issue and create a NEW commit
- Commit messages must follow Conventional Commits: `type(scope): description`
- Keep commit message first line under 72 characters
- Use Co-Authored-By trailer with "Claude Sonnet" since Sonnet does the analysis
