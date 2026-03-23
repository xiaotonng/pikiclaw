#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_DIR="${HOME}/.pikiclaw/dev"
PID_FILE="${DEV_DIR}/dev.pid"
APP_LOG="${DEV_DIR}/dev.log"
DETACHED_LOG="${DEV_DIR}/detached.out"
PORT="${PIKICLAW_DEV_PORT:-3940}"
KEEP_ALLOWLIST=0
TAIL_LINES=80

usage() {
  cat <<EOF
Usage:
  bash scripts/dev-service.sh foreground [--keep-feishu-allowlist]
  bash scripts/dev-service.sh start [--keep-feishu-allowlist]
  bash scripts/dev-service.sh stop
  bash scripts/dev-service.sh restart [--keep-feishu-allowlist]
  bash scripts/dev-service.sh status [--tail N]

Defaults:
  - FEISHU_ALLOWED_CHAT_IDS is unset unless --keep-feishu-allowlist is passed.
  - start/restart run detached and keep PID/logs under ~/.pikiclaw/dev.
EOF
}

command_for_pid() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null || true
}

listener_pid() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
}

pid_matches_repo_dev() {
  local pid="$1"
  local cmd
  cmd="$(command_for_pid "$pid")"
  [[ -n "$cmd" ]] || return 1
  [[ "$cmd" == *"$ROOT"* ]] || return 1
  [[ "$cmd" == *"src/cli.ts --no-daemon"* || "$cmd" == *"scripts/dev.sh"* || "$cmd" == *"npm run dev"* ]]
}

tree_contains_repo_dev() {
  local pid="$1"
  local child
  if pid_matches_repo_dev "$pid"; then
    return 0
  fi
  while IFS= read -r child; do
    [[ -n "$child" ]] || continue
    if pid_matches_repo_dev "$child"; then
      return 0
    fi
  done < <(collect_descendants "$pid")
  return 1
}

collect_descendants() {
  local pid="$1"
  local child
  while IFS= read -r child; do
    [[ -n "$child" ]] || continue
    collect_descendants "$child"
    printf '%s\n' "$child"
  done < <(pgrep -P "$pid" || true)
}

add_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  if has_target_pid "$pid"; then
    return 0
  fi
  TARGET_PIDS+=("$pid")
}

TARGET_PIDS=()

has_target_pid() {
  local pid="$1"
  local existing
  if [[ "${#TARGET_PIDS[@]}" -eq 0 ]]; then
    return 1
  fi
  for existing in "${TARGET_PIDS[@]}"; do
    [[ "$existing" == "$pid" ]] && return 0
  done
  return 1
}

collect_targets() {
  TARGET_PIDS=()

  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && tree_contains_repo_dev "$pid"; then
      add_pid "$pid"
      while IFS= read -r child; do
        add_pid "$child"
      done < <(collect_descendants "$pid")
    fi
  fi

  local listen_pid
  listen_pid="$(listener_pid)"
  if [[ -n "$listen_pid" ]] && pid_matches_repo_dev "$listen_pid"; then
    add_pid "$listen_pid"
    while IFS= read -r child; do
      add_pid "$child"
    done < <(collect_descendants "$listen_pid")
  fi

  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    add_pid "$pid"
  done < <(pgrep -f "$ROOT/node_modules/.bin/tsx src/cli.ts --no-daemon" || true)

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    add_pid "$pid"
  done < <(pgrep -f "$ROOT/scripts/dev.sh" || true)
}

wait_for_port_state() {
  local expected="$1"
  local tries="${2:-20}"
  local i
  for ((i = 0; i < tries; i++)); do
    if [[ "$expected" == "up" ]]; then
      if [[ -n "$(listener_pid)" ]]; then
        return 0
      fi
    else
      if [[ -z "$(listener_pid)" ]]; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

run_foreground() {
  mkdir -p "$DEV_DIR"
  if [[ "$KEEP_ALLOWLIST" -eq 0 ]]; then
    exec env -u FEISHU_ALLOWED_CHAT_IDS bash "$ROOT/scripts/dev.sh"
  fi
  exec bash "$ROOT/scripts/dev.sh"
}

launch_detached() {
  ROOT="$ROOT" DETACHED_LOG="$DETACHED_LOG" KEEP_ALLOWLIST="$KEEP_ALLOWLIST" python3 - <<'PY'
import os
import subprocess
import sys

root = os.environ['ROOT']
detached_log = os.environ['DETACHED_LOG']
keep_allowlist = os.environ.get('KEEP_ALLOWLIST') == '1'

env = os.environ.copy()
if not keep_allowlist:
    env.pop('FEISHU_ALLOWED_CHAT_IDS', None)

with open(detached_log, 'ab', buffering=0) as out, open(os.devnull, 'rb') as stdin:
    proc = subprocess.Popen(
        ['bash', os.path.join(root, 'scripts/dev.sh')],
        cwd=root,
        env=env,
        stdin=stdin,
        stdout=out,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
    )

sys.stdout.write(f'{proc.pid}\n')
PY
}

start_detached() {
  mkdir -p "$DEV_DIR"

  collect_targets
  if [[ "${#TARGET_PIDS[@]}" -gt 0 ]]; then
    echo "repo dev service is already running"
    print_status
    return 0
  fi

  : > "$DETACHED_LOG"
  local pid
  pid="$(launch_detached)"
  printf '%s\n' "$pid" > "$PID_FILE"
  printf 'started detached dev service pid=%s\n' "$pid"

  if ! wait_for_port_state up 30; then
    echo "dev service did not start listening on port $PORT" >&2
    print_status
    return 1
  fi
}

stop_detached() {
  collect_targets

  if [[ "${#TARGET_PIDS[@]}" -eq 0 ]]; then
    rm -f "$PID_FILE"
    echo "no repo dev process found"
    return 0
  fi

  local pid
  for pid in "${TARGET_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done

  sleep 1

  for pid in "${TARGET_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done

  rm -f "$PID_FILE"

  if ! wait_for_port_state down 20; then
    echo "dev service is still listening on port $PORT" >&2
    print_status
    return 1
  fi

  echo "stopped repo dev service"
}

print_status() {
  local pid=""
  local listen_pid=""

  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi
  listen_pid="$(listener_pid)"

  printf 'dev.pid: %s\n' "${pid:-missing}"
  printf 'listener: %s\n' "${listen_pid:-none}"
  if [[ -n "$listen_pid" ]]; then
    printf 'listener command: %s\n' "$(command_for_pid "$listen_pid")"
  fi
  echo '--- dev.log ---'
  tail -n "$TAIL_LINES" "$APP_LOG" 2>/dev/null || true
  echo '--- detached.out ---'
  tail -n "$TAIL_LINES" "$DETACHED_LOG" 2>/dev/null || true
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

COMMAND="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-feishu-allowlist)
      KEEP_ALLOWLIST=1
      ;;
    --tail)
      shift
      TAIL_LINES="${1:-80}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

case "$COMMAND" in
  foreground)
    run_foreground
    ;;
  start)
    start_detached
    print_status
    ;;
  stop)
    stop_detached
    ;;
  restart)
    stop_detached
    start_detached
    print_status
    ;;
  status)
    print_status
    ;;
  *)
    echo "unknown command: $COMMAND" >&2
    usage
    exit 1
    ;;
esac
