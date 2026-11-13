#!/bin/sh
# pilo for macOS: the newest release's archive, unpacked in a temporary folder, its installer run (#6240).
#   curl -fsSL https://pilo.garamnoh.workers.dev/install.sh | sh
# No Node, no sudo. The server goes in ~/.pilo, the app in ~/Applications; see the README for what it sends.
set -eu
[ "$(uname -s)" = "Darwin" ] || { echo "pilo runs on macOS only." >&2; exit 1; }
URL=$(curl -fsSL https://api.github.com/repos/garamnohhh/pilo/releases/latest | grep -o '"browser_download_url": *"[^"]*-mac\.tar\.gz"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')
[ -n "$URL" ] || { echo "No Mac archive on the latest release yet." >&2; exit 1; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
echo "Downloading $(basename "$URL")"
curl -fsSL -o "$T/pilo.tgz" "$URL"
tar xzf "$T/pilo.tgz" -C "$T"
/bin/bash "$(ls -d "$T"/pilo-*-mac)/install.sh"
