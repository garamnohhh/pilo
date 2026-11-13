#!/usr/bin/env bash
# A Pilo for a Mac with nothing on it (#6236): the Rust server (agent CLI and hooks in the same binary), the dashboard
# it serves, the pilo app with its terminal daemon, and install.sh, in one folder and a .tar.gz. No Node, no herdr.
# Ad hoc signed, not notarised: a downloaded copy needs its quarantine cleared (install.sh does it for its own files).
#   scripts/package-mac.sh [out dir]      (default dist/); PILO_DESK_REPO: the pilo-desk checkout (default ../pilo-desk)
set -euo pipefail
cd "$(dirname "$0")/.."
DESK="${PILO_DESK_REPO:-../pilo-desk}"
VER="$(grep -m1 '^version' rust/Cargo.toml | cut -d'"' -f2)"
OUT="${1:-dist}"; NAME="pilo-$VER-mac"; S="$OUT/$NAME"
(cd rust && cargo build --release --quiet)
(cd "$DESK" && cargo build --release --quiet)
rm -rf "$S"; mkdir -p "$S/bin" "$S/share/src" "$S/share/bin"
cp rust/target/release/pilo "$S/bin/pilo"; codesign --force --sign - --identifier dev.garamnoh.pilo "$S/bin/pilo" 2>/dev/null
cp -R public "$S/share/public"
cp src/markdown.js src/width.js src/commands.js src/text.js "$S/share/src/"
# only the version from package.json (the server reads it); its Node fields stay out of the archive
printf '{ "name": "pilo", "version": "%s" }\n' "$VER" > "$S/share/package.json"; cp bin/pilo-statusline "$S/share/bin/"; cp -R mods "$S/share/mods"
# the app as pilo-desk builds it, signed ad hoc (no personal certificate), installed into the folder instead of ~/Applications
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PILO_SIGN="ad hoc only" PILO_HOME="$T" PILO_APP_DIR="$S" "$DESK/scripts/install.sh" --no-build >/dev/null
cat > "$S/install.sh" <<'INSTALL'
#!/usr/bin/env bash
# Puts Pilo on this Mac: ~/.pilo/bin/pilo (server, agent CLI, hooks) and ~/.pilo/share (the dashboard),
# ~/Applications/pilo.app, the server and the terminal daemon at login, Pilo's hooks in Claude Code (and Codex).
# Run again to update; your requests stay in ~/.pilo/pilo.sqlite.
set -euo pipefail
cd "$(dirname "$0")"
P="$HOME/.pilo"; APP="$HOME/Applications/pilo.app"; LA="$HOME/Library/LaunchAgents/dev.garamnoh.pilo-serve.plist"
xattr -dr com.apple.quarantine . 2>/dev/null || true
mkdir -p "$P/bin" "$P/logs" "$P/desk/bin" "$HOME/.local/bin" "$HOME/Applications" "$HOME/Library/LaunchAgents"
cp bin/pilo "$P/bin/.pilo.new" && mv -f "$P/bin/.pilo.new" "$P/bin/pilo"
rm -rf "$P/share.new" && cp -R share "$P/share.new" && rm -rf "$P/share" && mv "$P/share.new" "$P/share"
ln -sf "$P/bin/pilo" "$HOME/.local/bin/pilo"
# an open window is closed for the new one (its terminals live in the daemon and stay); reopened below
WAS_OPEN=0; pgrep -f "$APP/Contents/MacOS/pilo-desk$" >/dev/null && { WAS_OPEN=1; osascript -e 'tell application id "dev.garamnoh.pilo-desk" to quit' >/dev/null 2>&1 || true; sleep 1; pkill -f "$APP/Contents/MacOS/pilo-desk$" || true; }
[ -e "$APP" ] && mv "$APP" "$HOME/.Trash/pilo-$(date +%Y%m%d-%H%M%S).app"
cp -R pilo.app "$APP"
cp pilo.app/Contents/MacOS/pilo-deskd "$P/desk/bin/.pilo-deskd.new" && mv -f "$P/desk/bin/.pilo-deskd.new" "$P/desk/bin/pilo-deskd"
"$P/desk/bin/pilo-deskd" --install-agent >/dev/null 2>&1 || true
cat > "$LA" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.garamnoh.pilo-serve</string>
  <key>ProgramArguments</key><array><string>$P/bin/pilo</string><string>serve</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$P/logs/pilo.log</string><key>StandardErrorPath</key><string>$P/logs/pilo.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/dev.garamnoh.pilo-serve" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$LA"
"$P/bin/pilo" hooks install
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$(cat "$P/port" 2>/dev/null || echo 48888)/health" >/dev/null 2>&1 && break; sleep 0.25; done
# the 'pilo' command in new terminals: ~/.local/bin on PATH, added once to the shell's own file (#6240)
# and in the login shell's file too: the app starts Claude Code and Codex in a login shell, by name (#6240)
RCS="$HOME/.zshrc $HOME/.zprofile"; [ "$(basename "${SHELL:-zsh}")" = "bash" ] && RCS="$HOME/.bash_profile"
for RC in $RCS; do grep -qs '.local/bin' "$RC" || printf '\n# pilo\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$RC"; done
# setup happens in the app, not a browser page (#6240)
open "$APP"
echo "Installed. pilo is open; setup continues there."
INSTALL
chmod +x "$S/install.sh"
tar -czf "$OUT/$NAME.tar.gz" -C "$OUT" "$NAME"
echo "$OUT/$NAME.tar.gz ($(du -h "$OUT/$NAME.tar.gz" | cut -f1))"
