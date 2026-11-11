#!/bin/sh
# Node -> Rust: stop the Node server (writes stop; the CLI spools meanwhile), carry
# its data into SQLite, point the launcher at the Rust binary and start it. The
# Node data folder stays as it was, for rollback.sh.
#   tools/db/cutover.sh            (PILO_HOME, PILO_PORT as the launcher reads them)
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
H="${PILO_HOME:-$HOME}/.pilo"
launcher="${PILO_LAUNCHER:-pilo}"
stamp=$(date +%Y%m%d-%H%M%S)
work="$H/cutover-$stamp"; mkdir -p "$work" "$H/rust"
# the binary the server runs is a copy: a later cargo build does not swap it under it
bin="$H/rust/pilo-$(git -C "$here" rev-parse --short HEAD)"
cp "$here/rust/target/release/pilo" "$bin"
t0=$(date +%s)
"$launcher" stop
node "$here/tools/db/pg-dump.mjs" "$H/data" "$work/node.jsonl"
[ -f "$H/pilo.sqlite" ] && mv "$H/pilo.sqlite" "$work/pilo.sqlite.before"
"$bin" db import "$work/node.jsonl" "$H/pilo.sqlite"
echo "$bin" > "$H/engine"
"$launcher" start
t1=$(date +%s)
"$bin" db export "$H/pilo.sqlite" "$work/rust.jsonl"
node "$here/tools/db/dump-diff.mjs" "$work/node.jsonl" "$work/rust.jsonl"
echo "cutover: down $((t1 - t0))s, server $(cat "$H/server.pid"), engine $bin, kept $H/data and $work"
