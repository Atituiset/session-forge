#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p dist

TARGETS=(
  "bun-linux-x64:session-forge-linux-x64"
  "bun-linux-arm64:session-forge-linux-arm64"
  "bun-darwin-x64:session-forge-macos-x64"
  "bun-darwin-arm64:session-forge-macos-arm64"
  "bun-windows-x64:session-forge-windows-x64.exe"
)

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  outfile="${entry#*:}"
  echo "==> building $target"
  bun build --compile --target="$target" src/cli.ts --outfile "dist/$outfile"
done

echo
ls -lh dist/
