---
name: install
description: This skill should be used when the user asks to "install codeclaw", "build and install", "deploy locally", "update local binary", "release", or "publish".
version: 7.0.0
---

# Install & Publish codeclaw

Every time this skill is invoked, execute ALL steps below in order:

## 1. Bump patch version

1. Read current version from `package.json`.
2. Increment the **patch** number (e.g. `0.2.25` → `0.2.26`).
3. Update **both** `package.json` `"version"` field and `src/bot.ts` `VERSION` constant to the new version.
4. Update the version examples in **this file** (SKILL.md) step 1's comments to reflect the new base version.

## 2. Build & local install

1. Run `npm run build` to compile TypeScript to `dist/`.
2. Run `npm link` in the project root.
3. Verify the new version with **`node dist/cli.js --version`** (do NOT use `codeclaw --version` — the npx cache may shadow the global link with a stale version).
4. If verification fails, diagnose and fix before proceeding.

## 3. Git commit, tag & push

1. Stage **all** changed, deleted, and untracked project files (`git add -A`), excluding secrets and build artifacts.
2. Commit with message: `chore: release v<new-version>`.
3. Create a git tag: `git tag v<new-version>`.
4. Push: `git push origin main --tags`.
5. Use `gh` to confirm the `Release` workflow for the pushed tag completes successfully.
6. Use `gh` to confirm the workflow's npm publish step succeeded before considering the release done.

## 4. Write release notes

After CI creates the GitHub Release, update it with meaningful release notes:

1. Run `git log v<previous-version>..v<new-version> --oneline --no-merges` to collect all commits since the last release.
2. Summarize changes into categories (use only relevant ones, skip empty categories):
   - **New Features** — new user-facing functionality
   - **Improvements** — enhancements to existing features
   - **Bug Fixes** — resolved issues
   - **Internal** — refactors, dependency updates, CI changes
3. Write concise, user-friendly descriptions (not raw commit messages).
4. Update the GitHub Release using:
   ```
   gh release edit v<new-version> --notes "$(cat <<'EOF'
   ## What's Changed

   ### New Features
   - description of feature

   ### Bug Fixes
   - description of fix

   **Full Changelog**: https://github.com/xiaotonng/codeclaw/compare/v<previous-version>...v<new-version>
   EOF
   )"
   ```
5. Verify the release notes look correct: `gh release view v<new-version>`.

## Prerequisites

- Node.js 18+.
- GitHub repo has `NPM_TOKEN` secret configured for CI.

## Notes

- `npm link` creates a global symlink — rebuild with `npm run build` after code changes.
- The `files` field in `package.json` controls what gets published: `dist/`, `LICENSE`, `README.md`.
- CI pipeline (`.github/workflows/release.yml`): builds, publishes to npm, and creates GitHub Release on `v*` tag push.
- To uninstall locally: `npm unlink -g codeclaw`.
