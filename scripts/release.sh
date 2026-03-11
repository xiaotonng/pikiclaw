#!/usr/bin/env bash
#
# release.sh — bump patch version, build, local install, commit, tag, push,
#               and wait for CI to finish.
#
# Usage:  ./scripts/release.sh
#
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

# ── 1. Bump patch version ────────────────────────────────────────────────────

OLD_VERSION=$(node -p "require('./package.json').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$OLD_VERSION"
NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"

echo "▸ Bumping version: $OLD_VERSION → $NEW_VERSION"

# Update package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Update VERSION constant in src/bot.ts
sed -i '' "s/export const VERSION = '${OLD_VERSION}'/export const VERSION = '${NEW_VERSION}'/" src/bot.ts

echo "  ✓ package.json and src/bot.ts updated"

# ── 2. Build & local install ─────────────────────────────────────────────────

echo "▸ Building…"
npm run build

echo "▸ Linking globally…"
npm link

INSTALLED=$(node dist/cli.js --version)
INSTALLED_VERSION=$(printf '%s\n' "$INSTALLED" | awk '{print $NF}')
if [ "$INSTALLED_VERSION" != "$NEW_VERSION" ]; then
  echo "✗ Version mismatch: expected $NEW_VERSION, got $INSTALLED" >&2
  exit 1
fi
echo "  ✓ Verified: $INSTALLED"

# ── 3. Git commit, tag & push ────────────────────────────────────────────────

echo "▸ Committing…"
git add -A
git commit -m "chore: release v${NEW_VERSION}"
git tag "v${NEW_VERSION}"

echo "▸ Pushing…"
git push origin main --tags

# ── 4. Wait for CI ───────────────────────────────────────────────────────────

echo "▸ Waiting for Release workflow…"
gh run list --workflow=release.yml --limit 1 --json databaseId,status -q '.[0].databaseId' \
  | xargs -I{} gh run watch {} --exit-status

echo ""
echo "✓ v${NEW_VERSION} released successfully!"
echo "  Run the install skill to generate release notes."
