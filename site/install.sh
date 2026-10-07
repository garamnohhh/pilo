#!/bin/sh
# Pilo installer. Clones the source into ~/.pilo/app and links the command.
# No sudo, no login items, no daemon beyond the server Pilo starts for itself.
#
# curl -fsSL https://pilo.garamnoh.workers.dev/install.sh | sh
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

# The newest release, not whatever is on main: vX.Y.Z tags only, compared as
# numbers. With no release at all, main is what there is.
TAG=$(git ls-remote --tags --refs "$REPO" 'v*' 2>/dev/null \
  | sed -n 's|.*refs/tags/\(v[0-9]*\.[0-9]*\.[0-9]*\)$|\1|p' \
  | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1)

mkdir -p "$APP" "$BIN"
if [ -d "$APP/.git" ]; then
  # npm rewrites package-lock.json by itself; that is not a local change
  if [ -n "$(git -C "$APP" status --porcelain -- . ':!package-lock.json')" ]; then
    die "$APP has local changes. Commit or drop them, then run this again."
  fi
  echo "Updating the copy in $APP to ${TAG:-main}"
  if [ -n "$TAG" ]; then
    git -C "$APP" fetch --depth 1 "$REPO" "refs/tags/$TAG:refs/tags/$TAG"
    git -C "$APP" checkout -q -- package-lock.json 2>/dev/null || true
    git -C "$APP" checkout -q "$TAG"
  else
    git -C "$APP" pull --ff-only
  fi
else
  echo "Cloning ${TAG:-main} into $APP"
  if [ -n "$TAG" ]; then
    git -c advice.detachedHead=false clone -q --depth 1 --branch "$TAG" "$REPO" "$APP"
  else
    git clone --depth 1 "$REPO" "$APP"
  fi
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
echo "Update it:  pilo update"
echo "Remove it:  rm -rf $APP $BIN/pilo      (your data stays in ~/.pilo)"
