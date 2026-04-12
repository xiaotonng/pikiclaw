#!/usr/bin/env bash
#
# release.sh — bump patch version, build, local install, commit, tag, push.
#
# Usage:  ./scripts/release.sh
#
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

# ── 1. Bump patch version ────────────────────────────────────────────────────

# Prefer the highest known release tag over package.json so stale local version
# files do not collide with an already-published tag.
git fetch --tags origin --quiet || true

PACKAGE_VERSION=$(node -p "require('./package.json').version")
LATEST_TAG=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-version:refname | head -n 1 || true)
LATEST_TAG_VERSION=${LATEST_TAG#v}
BASE_VERSION=$(node -e "
  const versions = process.argv.slice(1).filter(Boolean);
  const parsed = versions.map((value) => value.split('.').map(Number));
  parsed.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const [major, minor, patch] = parsed.at(-1);
  process.stdout.write(\`\${major}.\${minor}.\${patch}\`);
" "$PACKAGE_VERSION" "$LATEST_TAG_VERSION")
IFS='.' read -r MAJOR MINOR PATCH <<< "$BASE_VERSION"
NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
NEW_TAG="v${NEW_VERSION}"

echo "▸ Bumping version: $BASE_VERSION → $NEW_VERSION"

# Update package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Keep the lockfile version in sync so CI's npm ci installs the release version.
npm install --package-lock-only --ignore-scripts

echo "  ✓ package.json and package-lock.json updated"

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
git tag "$NEW_TAG"

echo "▸ Pushing…"
git push origin main "$NEW_TAG"

echo ""
echo "✓ v${NEW_VERSION} released successfully!"
echo "  CI will publish to npm in the background."
echo "  Run the install skill to generate release notes."
