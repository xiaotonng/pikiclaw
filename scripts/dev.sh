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
if pkill -f 'tsx src/cli.ts --no-daemon' 2>/dev/null; then
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

# Record our own PID so dev-service.sh and the next launch can find us
echo $$ > "${DEV_DIR}/dev.pid"
trap 'rm -f "${DEV_DIR}/dev.pid"' EXIT

: > "${LOG_FILE}"

export PIKICLAW_CONFIG="${DEV_DIR}/setting.json"
export PIKICLAW_LOG_LEVEL="${PIKICLAW_LOG_LEVEL:-debug}"
# Dev isolates setting.json only. The managed browser profile intentionally
# stays at ~/.pikiclaw/browser/chrome-profile so dev and the main runtime reuse
# the same browser login state.
unset CLAUDECODE

{
  npm run build:dashboard
  npx tsx src/cli.ts --no-daemon "$@"
} 2>&1 | node scripts/retained-tee.mjs "${LOG_FILE}"
