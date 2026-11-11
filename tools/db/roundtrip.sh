#!/bin/sh
# PGlite -> SQLite -> PGlite on a COPY of a data folder, comparing every table's
# rows each way. Never point it at a folder a live server has open.
#   tools/db/roundtrip.sh <copy of ~/.pilo/data> <empty work dir>
set -eu
src=$1; work=$2
[ -z "$(ls -A "$work" 2>/dev/null)" ] || { echo "$work is not empty"; exit 1; }
mkdir -p "$work"
here=$(cd "$(dirname "$0")/../.." && pwd)
pilo="$here/rust/target/debug/pilo"
[ -x "$pilo" ] || cargo build -q --manifest-path "$here/rust/Cargo.toml"
node "$here/tools/db/pg-dump.mjs" "$src" "$work/a.jsonl"
"$pilo" db import "$work/a.jsonl" "$work/pilo.sqlite"
"$pilo" db export "$work/pilo.sqlite" "$work/b.jsonl"
echo "-- PGlite -> SQLite"; node "$here/tools/db/dump-diff.mjs" "$work/a.jsonl" "$work/b.jsonl"
node "$here/tools/db/pg-restore.mjs" "$work/b.jsonl" "$work/back"
node "$here/tools/db/pg-dump.mjs" "$work/back" "$work/c.jsonl"
echo "-- SQLite -> PGlite (the way back)"; node "$here/tools/db/dump-diff.mjs" "$work/a.jsonl" "$work/c.jsonl"
