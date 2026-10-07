#!/bin/sh
# Pilo installer — a thin wrapper around npm, kept so the old one-line install
# still works. The plain way is the same thing:
#
#   npm install -g @garamnohhh/pilo
#
# curl -fsSL https://pilo.garamnoh.workers.dev/install.sh | sh
set -eu

die() { echo "" >&2; echo "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

have node || die "Pilo needs Node.js 20 or newer — https://nodejs.org"
have npm  || die "Pilo needs npm, which comes with Node.js."
[ "$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')" -ge 20 ] \
  || die "Pilo needs Node.js 20 or newer. This one is $(node -v)."
have herdr || echo "herdr is not installed yet — 'brew install herdr' before you start Pilo."

npm install -g @garamnohhh/pilo

echo ""
echo "Start it:   pilo"
echo "Update it:  pilo update"
echo "Remove it:  npm uninstall -g @garamnohhh/pilo      (your data stays in ~/.pilo)"
