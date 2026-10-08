#!/usr/bin/env bash
# Selective patchelf for linuxdeploy ($PATCHELF override).
#
# linuxdeploy sets an rpath on every ELF file in the AppDir via patchelf.
# patchelf rewrites the section layout, which destroys `bun build --compile`
# binaries: their JS payload is an overlay referenced by file offsets, and
# after patchelf the binary SEGFAULTS on startup and `ldd` fails silently
# (exit 1, no output). The gtk plugin's nested linuxdeploy run then aborts
# with "Failed to run ldd: exited with code 1", which tauri reports only as
# "failed to run linuxdeploy" (three release attempts lost to that message).
#
# The bun sidecars (engine + WSL/ssh scan agent) link only system libraries
# (libc, libpthread, libdl, libm), so they need no rpath at all — skipping
# them is both safe and REQUIRED for the shipped AppImage to work. Every
# other file (main binary, WebKit libraries, ...) goes to real patchelf.
set -euo pipefail

for last in "$@"; do :; done
case "$last" in
  *session-forge-engine*|*session-forge-linux-x64-agent*)
    echo "patchelf-selective: skipping rpath for bun sidecar: $last" >&2
    exit 0
    ;;
esac

exec "${REAL_PATCHELF:-/usr/bin/patchelf}" "$@"
