---
name: install
description: This skill should be used when the user asks to "install codeclaw", "build and install", "deploy locally", "update local binary", "release", or "publish".
version: 8.0.0
---

# Install & Publish codeclaw

## 1. Run the release script

```bash
./scripts/release.sh
```

This script handles: version bump → build → npm link → verify → git commit/tag/push → wait for CI.

If the script fails, diagnose and fix the issue, then re-run it.

## 2. Write release notes

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

## Notes

- `npm link` creates a global symlink — rebuild with `npm run build` after code changes.
- The `files` field in `package.json` controls what gets published: `dist/`, `LICENSE`, `README.md`.
- CI pipeline (`.github/workflows/release.yml`): builds, publishes to npm, and creates GitHub Release on `v*` tag push.
- To uninstall locally: `npm unlink -g codeclaw`.
