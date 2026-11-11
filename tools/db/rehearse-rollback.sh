#!/bin/sh
# Rust -> Node rollback rehearsal on a clone. Nothing live is touched: own homes, ports, sockets, fake herdr.
set -eu
W=${1:?usage: rehearse-rollback.sh <empty work dir>}
R=~/workspace/personal/github.com/garamnohhh/pilo-rust
N=~/workspace/personal/github.com/garamnohhh/pilo
rm -rf "$W"; mkdir -p "$W/rh/.pilo/logs" "$W/nh/.pilo/logs"
FAKE="$R/conformance/fake-herdr.js"
common="PILO_UPDATE_CHECK=off PILO_SKETCHYBAR= PILO_HERDR=$FAKE PILO_WATCHER=off PILO_RULES_ANYWHERE="
t0=$(date +%s)
# forward (what B5 does): live data clone -> dump -> SQLite, Rust serves it
cp -c -R ~/.pilo/data "$W/data.clone"
node "$R/tools/db/pg-dump.mjs" "$W/data.clone" "$W/a.jsonl"
"$R/rust/target/release/pilo" db import "$W/a.jsonl" "$W/rh/.pilo/pilo.sqlite"
env $common HOME="$W/rh" PILO_HOME="$W/rh" PILO_SOCKET="$W/r.sock" "$R/rust/target/release/pilo" serve --port 48951 >"$W/rust.log" 2>&1 &
RP=$!; sleep 2
curl -sf 127.0.0.1:48951/health >/dev/null
# a day of use on Rust: a request comes in, a note on it
IN=$(curl -sf -X POST 127.0.0.1:48951/api/inbox -H 'content-type: application/json' -d '{"text":"rollback rehearsal marker"}')
echo "rust wrote: $IN"
t1=$(date +%s)
# rollback: stop Rust, SQLite -> PGlite, Node serves it
kill $RP; wait $RP 2>/dev/null || true
"$R/rust/target/release/pilo" db export "$W/rh/.pilo/pilo.sqlite" "$W/b.jsonl"
node "$R/tools/db/pg-restore.mjs" "$W/b.jsonl" "$W/nh/.pilo/data"
(cd "$N" && env $common HOME="$W/nh" PILO_HOME="$W/nh" PILO_PORT=48952 PILO_SOCKET="$W/n.sock" node src/server.js >"$W/node.log" 2>&1) &
for i in $(seq 1 30); do curl -sf 127.0.0.1:48952/health >/dev/null && break; sleep 1; done
t2=$(date +%s)
echo "node health: $(curl -s 127.0.0.1:48952/health)"
echo "marker on node: $(curl -s '127.0.0.1:48952/api/inbox?limit=5' | grep -o 'rollback rehearsal marker' | head -1)"
echo "forward $((t1-t0))s rollback $((t2-t1))s"
NP=$(lsof -ti tcp:48952 -sTCP:LISTEN || true); [ -n "$NP" ] && kill $NP; sleep 2
node "$R/tools/db/pg-dump.mjs" "$W/nh/.pilo/data" "$W/c.jsonl"
echo "rows: before $(wc -l <"$W/a.jsonl") / after $(wc -l <"$W/c.jsonl")"
node "$R/tools/db/dump-diff.mjs" "$W/a.jsonl" "$W/c.jsonl" | tail -5
echo "stopped ports 48951 48952"
