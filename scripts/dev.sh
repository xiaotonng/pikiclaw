#!/usr/bin/env bash

set -euo pipefail

DEV_DIR="${HOME}/.pikiclaw/dev"
LOG_FILE="${DEV_DIR}/dev.log"

# Dev mode must stay on the local source tree.
# Do not hop into the production/self-bootstrap `npx pikiclaw@latest` chain.
mkdir -p "${DEV_DIR}"

# Kill any previous dev processes (npm -> bash -> tsx -> node tree)
_killed=0
# 1) Kill by "tsx src/cli.ts --no-daemon" pattern (the actual node worker)
if pkill -f 'tsx src/cli/main.ts --no-daemon' 2>/dev/null; then
  _killed=1
fi
# 2) Kill whatever is listening on the dev dashboard port
_port_pid=$(lsof -ti tcp:3940 2>/dev/null || true)
if [[ -n "$_port_pid" ]]; then
  echo "$_port_pid" | xargs kill 2>/dev/null || true
  _killed=1
fi
if (( _killed )); then
  echo "[dev.sh] killed previous dev process(es), waiting for cleanup..."
  sleep 0.5
fi
rm -f "${DEV_DIR}/dev.pid"

# Foreground when invoked from a real terminal; detach when piped (e.g. an
# agent's Bash tool call, or `npm run dev > /tmp/x.log`). Set
# PIKICLAW_DEV_FOREGROUND=1 to force foreground regardless of TTY, or
# PIKICLAW_DEV_BACKGROUND=1 to force detach.
_dev_foreground=1
if [[ "${PIKICLAW_DEV_BACKGROUND:-0}" == "1" ]]; then
  _dev_foreground=0
elif [[ "${PIKICLAW_DEV_FOREGROUND:-0}" == "1" ]]; then
  _dev_foreground=1
elif [[ ! -t 1 ]]; then
  _dev_foreground=0
fi

# Dev isolates setting.json only. The managed browser profile intentionally
# stays at ~/.pikiclaw/browser/chrome-profile so dev and the main runtime reuse
# the same browser login state.
#
# Clean inherited env vars that leak when launched from inside a running pikiclaw
# or Claude Code session. Without this, the dev process inherits agent permissions,
# channel credentials, daemon flags, workdir overrides, etc. from the parent.
# Use pattern-based unset to catch everything rather than maintaining an explicit list.
while IFS= read -r _var; do
  unset "$_var"
done < <(env | grep -oE '^(PIKICLAW_|CLAUDECODE|CLAUDE_CODE_|CLAUDE_MODEL|CLAUDE_PERMISSION_|CODEX_|GEMINI_|DEFAULT_AGENT|FEISHU_|TELEGRAM_|WEIXIN_)[^=]*' || true)

# Set dev-specific env AFTER the cleanup so they are not wiped.
export PIKICLAW_CONFIG="${DEV_DIR}/setting.json"
export PIKICLAW_LOG_LEVEL="${PIKICLAW_LOG_LEVEL:-debug}"

if (( _dev_foreground )); then
  echo $$ > "${DEV_DIR}/dev.pid"
  trap 'rm -f "${DEV_DIR}/dev.pid"' EXIT
  : > "${LOG_FILE}"
  {
    npm run build:dashboard
    npx tsx src/cli/main.ts --no-daemon "$@"
  } 2>&1 | node scripts/retained-tee.mjs "${LOG_FILE}"
else
  # Build dashboard synchronously so a build failure is visible to the caller
  # (the agent's Bash tool / CI), not silently swallowed in the detached log.
  : > "${LOG_FILE}"
  npm run build:dashboard 2>&1 | tee -a "${LOG_FILE}"

  # Detach with nohup (portable across macOS / Linux — `setsid` isn't on macOS).
  # nohup ignores SIGHUP so the daemon outlives the calling shell.
  nohup bash -c '
    exec npx tsx src/cli/main.ts --no-daemon "$@" 2>&1 \
      | node scripts/retained-tee.mjs "'"${LOG_FILE}"'"
  ' _ "$@" </dev/null >/dev/null 2>&1 &
  _bg_pid=$!
  disown "$_bg_pid" 2>/dev/null || true
  echo "$_bg_pid" > "${DEV_DIR}/dev.pid"

  cat <<EOF
[dev.sh] dev daemon detached (no TTY); wrapper pid=${_bg_pid}
[dev.sh]   log:  ${LOG_FILE}     (tail -f to follow)
[dev.sh]   stop: pkill -f 'tsx src/cli/main.ts --no-daemon'
[dev.sh]   force foreground next time: PIKICLAW_DEV_FOREGROUND=1 npm run dev
EOF
fi
