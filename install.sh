#!/bin/sh
# Pilo installer. Clones the source into ~/.pilo/app and links the command.
# No sudo, no login items, no daemon beyond the server Pilo starts for itself.
#
# curl -fsSL https://raw.githubusercontent.com/garamnohhh/pilo/main/install.sh | sh
set -eu

REPO=${REPO:-https://github.com/garamnohhh/pilo.git}
APP=${APP:-$HOME/.pilo/app}
BIN=${BIN:-$HOME/.local/bin}

die() { echo "" >&2; echo "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

have git  || die "Pilo needs git."
have node || die "Pilo needs Node.js 20 or newer — https://nodejs.org"
have npm  || die "Pilo needs npm, which comes with Node.js."
[ "$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')" -ge 20 ] \
  || die "Pilo needs Node.js 20 or newer. This one is $(node -v)."
have herdr || echo "herdr is not installed yet — 'brew install herdr' before you start Pilo."

mkdir -p "$APP" "$BIN"
if [ -d "$APP/.git" ]; then
  echo "Updating the copy in $APP"
  git -C "$APP" pull --ff-only
else
  echo "Cloning into $APP"
  git clone --depth 1 "$REPO" "$APP"
fi

( cd "$APP" && npm install --omit=dev --no-audit --no-fund )
ln -sf "$APP/bin/pilo" "$BIN/pilo"

echo ""
echo "Installed → $BIN/pilo"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "Add it to your PATH:  export PATH=\"$BIN:\$PATH\"" ;;
esac
echo "Start it:   pilo"
echo "Remove it:  rm -rf $APP $BIN/pilo      (your data stays in ~/.pilo)"
