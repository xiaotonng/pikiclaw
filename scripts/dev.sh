#!/usr/bin/env bash

set -euo pipefail

DEV_DIR="${HOME}/.pikiclaw/dev"
LOG_FILE="${DEV_DIR}/dev.log"

# Dev mode must stay on the local source tree.
# Do not hop into the production/self-bootstrap `npx pikiclaw@latest` chain.
mkdir -p "${DEV_DIR}"
: > "${LOG_FILE}"

export PIKICLAW_CONFIG="${DEV_DIR}/setting.json"
unset CLAUDECODE

{
  npm run build:dashboard
  tsx src/cli.ts --no-daemon "$@"
} 2>&1 | tee "${LOG_FILE}"
