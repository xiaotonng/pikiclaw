#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "[build] building codeclaw binary..."
pyinstaller \
  --onefile \
  --name codeclaw \
  --clean \
  --noconfirm \
  codeclaw.py

rm -rf build/ codeclaw.spec
echo "[build] done: dist/codeclaw ($(du -h dist/codeclaw | cut -f1))"
