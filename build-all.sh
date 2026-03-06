#!/usr/bin/env bash
# build-all.sh — Build codeclaw binary for the current platform.
#
# PyInstaller can only cross-compile for the OS it runs on.
# For multi-platform releases, use the GitHub Actions workflow
# (.github/workflows/release.yml) which builds on macOS, Linux, and Windows.
#
# Usage:
#   pip install pyinstaller
#   ./build-all.sh

set -euo pipefail
cd "$(dirname "$0")"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

# Normalize
case "$OS" in
  darwin)  OS="darwin" ;;
  linux)   OS="linux" ;;
  mingw*|msys*|cygwin*) OS="windows" ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x86_64" ;;
esac

BINARY_NAME="codeclaw-${OS}-${ARCH}"
if [ "$OS" = "windows" ]; then
  BINARY_NAME="${BINARY_NAME}.exe"
fi

echo "[build] platform: ${OS}/${ARCH}"
echo "[build] output: dist/${BINARY_NAME}"

pyinstaller \
  --onefile \
  --name "$BINARY_NAME" \
  --clean \
  --noconfirm \
  codeclaw.py

rm -rf build/ *.spec
echo "[build] done: dist/${BINARY_NAME} ($(du -h "dist/${BINARY_NAME}" | cut -f1))"
