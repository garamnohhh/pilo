#!/bin/sh
# Pilo installer.
#
#   curl -fsSL https://pilo.garamnoh.workers.dev/install.sh | sh
#
# With a patched Node.js (22.23.4+ or 24.22.1+) it is the plain npm install. Without it, pilo gets a
# private Node of its own in ~/.pilo/runtime, from nodejs.org and checked
# against its SHASUMS256.txt, and that Node runs pilo alone: the Node on PATH,
# nvm and the rest are left as they are.
set -eu

PKG="${PILO_PACKAGE:-@garamnohhh/pilo}"
NODE_MAJOR=24
PILO_DIR="${PILO_HOME:-$HOME}/.pilo"
RUNTIME="$PILO_DIR/runtime"
BIN_DIR="$HOME/.local/bin"

die() { echo "" >&2; echo "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
node_ok() {
  have node && have npm \
    && node -e 'const [a, b, c] = process.versions.node.split(".").map(Number); process.exit(a === 22 ? (b > 23 || (b === 23 && c >= 4)) ? 0 : 1 : a === 24 ? (b > 22 || (b === 22 && c >= 1)) ? 0 : 1 : a > 24 ? 0 : 1)' 2>/dev/null
}

[ "$(uname -s)" = Darwin ] || die "pilo runs on macOS only."
have herdr || [ -x "$HOME/.local/bin/herdr" ] || echo "herdr is not installed yet: 'curl -fsSL https://herdr.dev/install.sh | sh' before you start pilo."

if node_ok; then
  npm install -g "$PKG"
  echo ""
  echo "Start it:   pilo"
  echo "Update it:  pilo update"
  echo "Remove it:  npm uninstall -g @garamnohhh/pilo      (your data stays in ~/.pilo)"
  exit 0
fi

case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) die "No Node.js build for $(uname -m)." ;;
esac
echo "No patched Node.js here (22.23.4+ or 24.22.1+), so pilo gets a private one in $RUNTIME."
echo "Your own Node, if any, is left as it is."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp" "$RUNTIME.new"' EXIT
base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
file="$(grep -o "node-v[0-9.]*-darwin-$arch\.tar\.xz" "$tmp/SHASUMS256.txt" | head -n 1)"
[ -n "$file" ] || die "Could not find a Node.js $NODE_MAJOR build for darwin-$arch."
echo "Downloading $file"
curl -fSL --progress-bar "$base/$file" -o "$tmp/$file"
(cd "$tmp" && grep "  $file\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) \
  || die "$file does not match nodejs.org's checksum. Nothing was installed."

# Built beside the old runtime and swapped in at the end, so a failure leaves
# whatever worked before.
mkdir -p "$RUNTIME.new"
tar -xJf "$tmp/$file" -C "$RUNTIME.new" --strip-components 1
PATH="$RUNTIME.new/bin:$PATH" npm_config_update_notifier=false npm install -g --prefix "$RUNTIME.new" "$PKG" --no-audit --no-fund
[ -d "$RUNTIME" ] && mv "$RUNTIME" "$tmp/old"
mv "$RUNTIME.new" "$RUNTIME"

mkdir -p "$BIN_DIR"
ln -sf "$RUNTIME/bin/pilo" "$BIN_DIR/pilo"

echo ""
echo "Installed pilo with its own Node ($("$RUNTIME/bin/node" -v)) in $RUNTIME."
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to your PATH, then open a new terminal:"
     echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc" ;;
esac
first="$(command -v pilo 2>/dev/null || true)"
if [ -n "$first" ] && [ "$first" != "$BIN_DIR/pilo" ]; then
  echo "Another pilo comes first on your PATH: $first"
  echo "Remove it (npm uninstall -g @garamnohhh/pilo) or put $BIN_DIR ahead of it."
fi
echo "Start it:   pilo"
echo "Update it:  pilo update"
echo "Remove it:  rm -rf ~/.pilo/runtime ~/.local/bin/pilo      (your data stays in ~/.pilo)"
