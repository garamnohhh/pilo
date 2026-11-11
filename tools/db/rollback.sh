#!/bin/sh
# Rust -> Node: stop the Rust server, carry the SQLite rows back into a new
# PGlite folder, put it in place of the old one (kept beside it), and start the
# Node server. The SQLite file stays where it is.
#   tools/db/rollback.sh
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
H="${PILO_HOME:-$HOME}/.pilo"
launcher="${PILO_LAUNCHER:-pilo}"
stamp=$(date +%Y%m%d-%H%M%S)
work="$H/rollback-$stamp"; mkdir -p "$work"
bin=$(cat "$H/engine")
t0=$(date +%s)
"$launcher" stop
"$bin" db export "$H/pilo.sqlite" "$work/rust.jsonl"
node "$here/tools/db/pg-restore.mjs" "$work/rust.jsonl" "$work/data"
mv "$H/data" "$H/data.before-rollback-$stamp"
mv "$work/data" "$H/data"
mv "$H/engine" "$work/engine"
"$launcher" start
t1=$(date +%s)
echo "rollback: down $((t1 - t0))s, Node on $H/data, Rust rows kept in $H/pilo.sqlite, old Node data $H/data.before-rollback-$stamp"
