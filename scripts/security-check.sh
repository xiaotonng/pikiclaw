#!/usr/bin/env bash
#
# security-check.sh — refuse the release if dangerous content is staged.
#
# Scans the files that would be in the next commit (tracked + untracked
# but not gitignored) for:
#   • forbidden filename patterns (debug logs, secret files, private keys)
#   • token / credential patterns inside file contents
#
# Wired into scripts/release.sh as step 0. Can also be invoked manually:
#     ./scripts/security-check.sh
#
# Bypass once (only after eyeballing the matches and confirming they are
# safe):
#     SECURITY_CHECK_BYPASS=1 ./scripts/release.sh
#
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

if [ "${SECURITY_CHECK_BYPASS:-}" = "1" ]; then
  echo "▸ Security check: bypassed via SECURITY_CHECK_BYPASS=1"
  exit 0
fi

echo "▸ Security check: scanning paths…"

# Build the list of files that would be in the next commit:
# tracked (-c) + untracked but not gitignored (-o --exclude-standard).
files=()
while IFS= read -r line; do
  [ -n "$line" ] && [ -f "$line" ] && files+=("$line")
done < <(git ls-files -c -o --exclude-standard | sort -u)

violations=0

# ── 1. Forbidden filename / directory patterns ──────────────────────────
forbidden_paths=(
  '\.playwright-mcp/'                         # browser MCP debug logs
  '(^|/)\.env$'                                # .env at root or nested
  '(^|/)\.env\.[^/]*$'                         # .env.local, .env.production, etc.
  '\.pem$'                                     # PEM key/cert
  '\.p12$'                                     # PKCS#12 archive
  '\.pfx$'                                     # PFX archive
  '(^|/)id_(rsa|dsa|ed25519|ecdsa)$'           # ssh private keys
  '(^|/)\.npmrc$'                              # may contain auth token
  '\.aws/credentials$'                         # AWS shared credentials
)

# Allowlist for the .env family: example / sample / template files are docs.
env_example_allow='\.env\.(example|sample|template)$'

for pat in "${forbidden_paths[@]}"; do
  hits=()
  for f in "${files[@]}"; do
    if printf '%s' "$f" | grep -qE "$pat"; then
      if printf '%s' "$f" | grep -qE "$env_example_allow"; then
        continue
      fi
      hits+=("$f")
    fi
  done
  if [ ${#hits[@]} -gt 0 ]; then
    echo "  ✗ Forbidden path pattern: $pat"
    for h in "${hits[@]}"; do
      echo "      $h"
    done
    violations=$((violations + 1))
  fi
done

echo "▸ Security check: scanning content…"

# ── 2. Token / credential patterns in file contents ─────────────────────
content_patterns=(
  # JWT (eyJ-prefixed 3-segment base64url)
  'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
  # Authorization bearer — URL-encoded or plain
  'Authorization=Bearer%20'
  'Authorization:[[:space:]]*Bearer[[:space:]]+[A-Za-z0-9_.+/=-]{20,}'
  # AWS access key id
  'AKIA[0-9A-Z]{16}'
  # GitHub personal access tokens / app tokens
  'gh[pousr]_[A-Za-z0-9]{36,}'
  # Slack token (real ones are 40+ chars after the prefix; this avoids
  # matching i18n placeholders like "xoxb-1234567890-abc")
  'xox[bpoars]-[0-9A-Za-z-]{40,}'
  # OpenAI key (real keys are 48+ chars after sk-)
  'sk-(proj-)?[A-Za-z0-9_-]{40,}'
  # Anthropic key
  'sk-ant-[A-Za-z0-9_-]{40,}'
  # Stripe live key
  'sk_live_[A-Za-z0-9]{24,}'
  # PEM-style private key blocks
  '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'
)
combined_pattern=$(IFS='|'; echo "${content_patterns[*]}")

# Skip the scanner itself (its source contains the patterns above).
scan_files=()
for f in "${files[@]}"; do
  case "$f" in
    scripts/security-check.sh) continue ;;
  esac
  # Skip files larger than 2 MiB (binaries, bundled assets).
  size=$(wc -c <"$f" 2>/dev/null | awk '{print $1}')
  [ -n "$size" ] && [ "$size" -gt 2097152 ] && continue
  scan_files+=("$f")
done

content_hits=""
if [ ${#scan_files[@]} -gt 0 ]; then
  # -I skips binary files; -H prefixes filename; -n prefixes line number.
  content_hits=$(grep -EHnI --color=never "$combined_pattern" "${scan_files[@]}" 2>/dev/null || true)
fi

if [ -n "$content_hits" ]; then
  echo "  ✗ Secret-looking patterns in content:"
  # Truncate each match line so dumped JWTs don't spam the terminal.
  printf '%s\n' "$content_hits" | awk -F: '{
    line=$0
    if (length(line) > 200) { line = substr(line, 1, 200) "… [truncated]" }
    print "      " line
  }' | head -50
  violations=$((violations + 1))
fi

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "✗ Security check failed: $violations violation(s)."
  echo ""
  echo "  Either:"
  echo "    a) Remove the offending content from the working tree, OR"
  echo "    b) Override once with: SECURITY_CHECK_BYPASS=1 <command>"
  echo "       (only after manually verifying the matches are safe)"
  exit 1
fi

echo "✓ Security check passed."
