#!/usr/bin/env bash
# Postgres 컨테이너에서 PGlite 로 한 번에 옮긴다. 사람이 끝까지 지켜보며 돌리는 스크립트.
#
#   ~/pilo-switch.sh --dry-run   확인만. 아무것도 바꾸지 않음 — 반드시 먼저
#   ~/pilo-switch.sh --run       실제 전환
#   ~/pilo-switch.sh --check     전환 뒤 확인만 다시(5·7단계). 아무것도 바꾸지 않음
#
# 저장소 밖으로 꺼내서 돌린다. 3단계 병합이 저장소 파일을 바꾸기 때문:
#   git -C ~/workspace/personal/github.com/garamnohhh/pilo show pglite:scripts/switch-to-pglite.sh > ~/pilo-switch.sh
#
# 멈추면 마지막 ✕ 아래 "되돌리기" 를 그대로 친다. 덤프·건수·로그는 ~/.pilo/switch-<시각>/ 에 남는다.
# 경로를 바꿔 격리 인스턴스에서 돌릴 때: PILO_REPO PILO_HOME PILO_PORT PILO_SPOOL PILO_CONTAINER PILO_PG_DB
set -euo pipefail

MODE="${1:-}"
case "$MODE" in --dry-run|--run|--check) ;; *) echo "usage: $0 --dry-run | --run | --check"; exit 2 ;; esac

REPO="${PILO_REPO:-$HOME/workspace/personal/github.com/garamnohhh/pilo}"
HOME_DIR="${PILO_HOME:-$HOME}/.pilo"
CONTAINER="${PILO_CONTAINER:-pilo-postgres}"
PGDB="${PILO_PG_DB:-pilo}"
BRANCH="${PILO_BRANCH:-pglite}"
PORT="${PILO_PORT:-48888}"
TMP="${TMPDIR:-/tmp}"; TMP="${TMP%/}"
SPOOL="${PILO_SPOOL:-$TMP/pilo-spool}"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$HOME_DIR/switch-$STAMP"
TABLES="agents projects inbox tasks events final_replies artifacts schedules agent_sessions settings schema_migrations"
PILO="$REPO/bin/pilo"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
UNDO="아무것도 안 바뀜. 그대로 두면 됨"
die()  { printf '\n  ✕ %s\n\n  되돌리기:\n' "$1"; printf '%s\n' "$UNDO" | sed 's/^/    /'; exit 1; }

psql_()  { docker exec "$CONTAINER" psql -U pilo -d "$PGDB" -tAc "$1"; }
health() { curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null; }
api()    { curl -fsS "http://127.0.0.1:$PORT$1"; }

# JSON 한 조각을 파이썬으로 읽는다. 못 읽으면 죽지 않고 "확인 못 함"
py() { python3 -c 'import sys, json
try:
    d = json.load(sys.stdin)
    exec(sys.argv[1])
except Exception:
    print("확인 못 함")' "$1" 2>/dev/null || echo "확인 못 함"; }
# /api/system 의 services 한 줄. 이름: server · postgres · wake(herdr 바인딩) · dashboard — 옛 서버·새 서버 같음
svc() { { api /api/system 2>/dev/null || true; } | py "print(next((s.get('detail', '') for s in d['services'] if s.get('name') == '$1'), '확인 못 함'))"; }

# 이 PILO_HOME 을 쓰는 프로세스만 (다른 격리 인스턴스는 건드리지 않게)
ours() {
  local pid="$1" home
  home="$(ps eww -o command= -p "$pid" 2>/dev/null | tr ' ' '\n' | sed -n 's/^PILO_HOME=//p' | head -1)"
  [ "${home:-$HOME}/.pilo" = "$HOME_DIR" ]
}
server_pids() { for pid in $(ps -Ao pid=,command= | awk -v s="$REPO/src/server.js" 'index($0, s) && !/awk/ {print $1}'); do ours "$pid" && printf '%s ' "$pid"; done; true; }
tui_pids()    { for pid in $(ps -Ao pid=,command= | awk '$2 == "Pilo" && NF == 2 {print $1}'); do ours "$pid" && printf '%s ' "$pid"; done; true; }

live_counts() { for t in $TABLES; do printf '%s %s\n' "$t" "$(psql_ "SELECT count(*) FROM $t")"; done; }
dump_counts() {
  python3 - "$1" $TABLES <<'PY'
import re, sys
path, tables = sys.argv[1], sys.argv[2:]
n = dict.fromkeys(tables, 0)
with open(path, encoding="utf8", errors="replace") as fh:
    for line in fh:
        m = re.match(r"INSERT INTO public\.(\w+) ", line)
        if m and m.group(1) in n:
            n[m.group(1)] += 1
for t in tables:
    print(t, n[t])
PY
}
pglite_counts() {
  (cd "$REPO" && node --input-type=module -e "
    const { query } = await import('./src/db.js');
    for (const t of process.argv.slice(1)) console.log(t, (await query('SELECT count(*)::int AS n FROM ' + t))[0].n);
    process.exit(0);
  " $TABLES)
}
# 5단계 판정: 새 서버가 새 코드 + PGlite 로 떴는지. 어긋난 줄을 ! 로 적고 1 을 돌려줌
check_start() {
  PORT="$(cat "$HOME_DIR/port" 2>/dev/null || echo "$PORT")"
  local lockpid db bad=0
  lockpid="$(cat "$HOME_DIR/db.lock" 2>/dev/null || true)"
  if [ -n "$lockpid" ] && kill -0 "$lockpid" 2>/dev/null; then ok "db.lock → 살아 있는 서버 pid $lockpid"
  else warn "db.lock 이 살아 있는 서버를 가리키지 않음"; bad=1; fi
  db="$(svc postgres)"
  case "$db" in
    PGlite*) ok "DB: $db" ;;
    "확인 못 함") warn "DB 종류 확인 못 함(/api/system) — db.lock·/api/history 로 판단" ;;
    *) warn "서버가 PGlite 로 뜨지 않음: $db"; bad=1 ;;
  esac
  if api "/api/history?q=pilo&limit=1" >/dev/null 2>&1; then ok "/api/history 응답 — 새 코드"
  else warn "/api/history 응답 없음 — 새 코드가 안 떴음"; bad=1; fi
  return $bad
}

# 7단계: 확인만. 못 읽는 항목은 "확인 못 함" 으로 적고 계속
check_after() {
  local hist stream
  local agents wake recent
  agents="$(api /api/agents 2>/dev/null | py 'print(len(d))')"
  wake="$(svc wake)"
  recent="$(api '/api/inbox?limit=1' 2>/dev/null | py 'r = d[0]; print("in-%s %s %s" % (r["id"], r["status"], r["userRequest"][:40].replace(chr(10), " ")))')"
  case "$agents $wake" in *"확인 못 함"*) warn "에이전트 ${agents} · ${wake}" ;; *) ok "에이전트 ${agents}개 · ${wake}" ;; esac
  case "$recent" in "확인 못 함") warn "최근 요청 확인 못 함" ;; *) ok "최근 요청: $recent" ;; esac
  hist="$("$PILO" history 수덕사 --limit 1 2>&1 | head -1 || true)"
  case "$hist" in in-*) ok "pilo history: $hist" ;; *) warn "pilo history 확인 못 함: $hist" ;; esac
  stream="$(curl -sN --max-time 2 "http://127.0.0.1:$PORT/api/stream" 2>/dev/null | head -c 11 || true)"
  if [ "$stream" = "retry: 3000" ]; then ok "SSE 스트림 응답"; else warn "SSE 스트림 확인 못 함: '$stream'"; fi
}

same() { # 두 건수 파일이 같은지, 다르면 나란히 보여줌
  if diff -q "$1" "$2" >/dev/null; then return 0; fi
  paste "$1" "$2" | awk '{ printf "      %-17s %8s %8s %s\n", $1, $2, $4, ($2 == $4 ? "" : "← 다름") }'
  return 1
}

if [ "$MODE" = --check ]; then
  bold "전환 뒤 확인 (--check, 바뀌는 것 없음)"
  rc=0
  check_start || rc=1
  check_after
  if [ "$rc" = 0 ]; then bold "확인 끝 — 새 서버 정상"; else bold "확인 끝 — 위 ! 줄 확인 필요"; fi
  exit "$rc"
fi

# ------------------------------------------------------------------ 0. 사전 확인
bold "0. 사전 확인 ($MODE)"
for c in docker node npm git curl python3; do command -v "$c" >/dev/null || die "$c 명령이 없음"; done
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node 20 이상 필요 (지금 $(node -v))"
ok "node $(node -v) · npm $(npm -v)"
[ -x "$PILO" ] || die "저장소를 못 찾음: $REPO (PILO_REPO 로 지정)"
cd "$REPO"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "지금 브랜치가 main 이 아님: $(git rev-parse --abbrev-ref HEAD)"
[ -z "$(git status --porcelain)" ] || die "저장소에 커밋 안 된 변경이 있음 — git -C $REPO status"
git rev-parse -q --verify "$BRANCH" >/dev/null || die "$BRANCH 브랜치가 없음"
git merge-base --is-ancestor main "$BRANCH" || die "main 이 $BRANCH 에 들어 있지 않아 fast-forward 불가 — 브랜치를 main 에 다시 맞춰야 함"
MAIN_BEFORE="$(git rev-parse --short main)"
TARGET="$(git rev-parse --short "$BRANCH")"
ok "main $MAIN_BEFORE → $BRANCH $TARGET ($(git rev-list --count main.."$BRANCH")개 커밋) fast-forward 가능"
git show "$BRANCH:package.json" | grep -q '"@electric-sql/pglite"' || die "$BRANCH 에 PGlite 의존성이 없음"
docker exec "$CONTAINER" pg_isready -U pilo -d "$PGDB" >/dev/null 2>&1 || die "Postgres 컨테이너($CONTAINER) 응답 없음 — docker start $CONTAINER"
ok "Postgres $CONTAINER/$PGDB 응답"
free_kb="$(df -Pk "$(dirname "$HOME_DIR")" | awk 'NR==2 {print $4}')"
[ "$free_kb" -gt 1048576 ] || die "디스크 여유가 1GB 미만"
ok "디스크 여유 $((free_kb / 1048576))GB"
if health >/dev/null; then ok "서버 동작 중 (port $PORT, pid $(server_pids))"; else warn "서버가 이미 꺼져 있음 (port $PORT) — 괜찮음"; fi

stop_here=0
running="$(psql_ "SELECT string_agg('#' || t.id || ' ' || coalesce(a.name, '?') || ' ' || t.status, ', ' ORDER BY t.id) FROM tasks t LEFT JOIN agents a ON a.id = t.to_agent_id WHERE t.status IN ('queued', 'running')")"
waiting="$(psql_ "SELECT string_agg('#' || t.id || ' ' || t.status, ', ' ORDER BY t.id) FROM tasks t WHERE t.status IN ('blocked', 'holding')")"
fresh="$(psql_ "SELECT string_agg('in-' || i.id, ', ' ORDER BY i.id) FROM inbox i WHERE NOT EXISTS (SELECT 1 FROM final_replies f WHERE f.inbox_id = i.id) AND i.created_at > now() - interval '24 hours'")"
if [ -n "$running" ]; then warn "진행 중인 task: $running"; stop_here=1; else ok "진행 중인 task 없음"; fi
if [ -n "$fresh" ]; then warn "최근 24시간 답 없는 요청: $fresh"; stop_here=1; else ok "최근 24시간 답 없는 요청 없음"; fi
[ -z "$waiting" ] || info "결정·외부 대기 task: $waiting — 그대로 이관됨(전환과 무관)"
tuis="$(tui_pids)"
if [ -n "$tuis" ]; then warn "TUI 가 열려 있음 (pid $tuis) — 새 코드로 다시 열려면 :exit 로 끄고 시작"; else ok "TUI 꺼져 있음"; fi
if [ -e "$HOME_DIR/data" ]; then
  warn "옛 PGlite 디렉터리 있음: $HOME_DIR/data ($(du -sh "$HOME_DIR/data" | cut -f1), $(stat -f %Sm -t %Y-%m-%d "$HOME_DIR/data")) — --run 이 data.before-$STAMP 로 옮김(안 지움)"
fi
pending="$(find "$SPOOL" -maxdepth 1 -name 'req-*.json' 2>/dev/null | wc -l | tr -d ' ')"
[ "$pending" = 0 ] && ok "스풀 대기 요청 없음" || warn "스풀에 처리 안 된 요청 ${pending}건 — --run 이 작업 폴더로 옮김"
info "지금 Postgres 건수:"
live_counts | awk '{ printf "      %-17s %s\n", $1, $2 }'

if [ "$MODE" = --dry-run ]; then
  if [ "$stop_here" = 1 ]; then bold "dry-run 끝 — 바뀐 것 없음. 위 ! 중 진행 중 작업이 남아 있어 지금 --run 은 멈춤"
  else bold "dry-run 끝 — 바뀐 것 없음. --run 가능"; fi
  exit 0
fi
[ "$stop_here" = 0 ] || [ "${PILO_SWITCH_ALLOW_OPEN:-}" = 1 ] \
  || die "진행 중인 작업이 있어 멈춤. 끝나길 기다리거나, 버려도 되면 PILO_SWITCH_ALLOW_OPEN=1 을 앞에 붙여 다시"

mkdir -p "$WORK"; chmod 700 "$WORK"
exec > >(tee -a "$WORK/switch.log") 2>&1
info "작업 폴더: $WORK"

# ------------------------------------------------------------------ 1. 서버 정지
bold "1. 서버 정지"
"$PILO" stop >/dev/null
for _ in $(seq 1 40); do health >/dev/null || break; sleep 0.25; done
health >/dev/null && die "서버가 안 꺼짐 — pilo stop 을 다시, 안 되면 kill $(server_pids)"
left="$(server_pids)"
[ -z "$left" ] || die "서버 프로세스가 남아 있음: $left — kill $left 후 다시"
ok "서버 꺼짐 — 지금부터 에이전트 pilo 명령 · watcher · 대시보드 · TUI 가 끊김"
UNDO="$PILO up        # Postgres 그대로, 데이터 안 바뀜"

# ------------------------------------------------------------------ 2. 덤프
bold "2. 덤프 (서버가 꺼진 뒤라 이후 쓰기 없음)"
docker exec "$CONTAINER" pg_dump -U pilo -d "$PGDB" --inserts --no-owner --no-privileges > "$WORK/pilo.sql" || die "pg_dump(--inserts) 실패"
docker exec "$CONTAINER" pg_dump -U pilo -d "$PGDB" -Fc > "$WORK/pilo.pgdump" || die "pg_dump(custom) 실패"
live_counts > "$WORK/counts-postgres.txt"
dump_counts "$WORK/pilo.sql" > "$WORK/counts-dump.txt"
same "$WORK/counts-postgres.txt" "$WORK/counts-dump.txt" || die "덤프 건수가 Postgres 와 다름"
psql_ "SELECT 'inbox ' || coalesce(max(id), 0) FROM inbox UNION ALL SELECT 'tasks ' || coalesce(max(id), 0) FROM tasks UNION ALL SELECT 'final_replies ' || coalesce(max(id), 0) FROM final_replies UNION ALL SELECT 'events ' || coalesce(max(id), 0) FROM events" > "$WORK/max-ids.txt"
ok "덤프 $(du -h "$WORK/pilo.sql" | cut -f1) · 건수 일치 — $(tr '\n' ' ' < "$WORK/counts-dump.txt")"

# ------------------------------------------------------------------ 3. main 반영
bold "3. main 에 $BRANCH 반영 + 의존성 설치"
UNDO="git -C $REPO reset --hard $MAIN_BEFORE && (cd $REPO && npm ci)
$PILO up        # Postgres 그대로, 데이터 안 바뀜"
git merge --ff-only "$BRANCH" >/dev/null || die "fast-forward 실패"
npm ci --no-audit --no-fund > "$WORK/npm-ci.log" 2>&1 || die "npm ci 실패 — $WORK/npm-ci.log"
node --input-type=module -e "await import('@electric-sql/pglite')" >/dev/null 2>&1 || die "PGlite 모듈을 못 불러옴"
ok "main $MAIN_BEFORE → $(git rev-parse --short HEAD) · PGlite $(node -p "require('./node_modules/@electric-sql/pglite/package.json').version" 2>/dev/null || echo "버전 확인 못 함")"

# ------------------------------------------------------------------ 4. 이관
bold "4. PGlite 로 이관"
UNDO="rm -rf $HOME_DIR/data.failed-$STAMP; [ -e $HOME_DIR/data ] && mv $HOME_DIR/data $HOME_DIR/data.failed-$STAMP
git -C $REPO reset --hard $MAIN_BEFORE && (cd $REPO && npm ci)
$PILO up        # Postgres 그대로, 데이터 안 바뀜"
if [ -e "$HOME_DIR/data" ]; then mv "$HOME_DIR/data" "$HOME_DIR/data.before-$STAMP"; ok "옛 PGlite 디렉터리 → data.before-$STAMP"; fi
if [ "$pending" != 0 ]; then mkdir -p "$WORK/spool"; find "$SPOOL" -maxdepth 1 -name 'req-*.json' -exec mv {} "$WORK/spool/" \; ; ok "스풀 요청 ${pending}건 → $WORK/spool"; fi
node scripts/import-postgres.mjs "$WORK/pilo.sql" > "$WORK/import.log" 2>&1 || { cat "$WORK/import.log"; die "import 실패"; }
pglite_counts > "$WORK/counts-pglite.txt" 2>"$WORK/counts-pglite.err" || { cat "$WORK/counts-pglite.err"; die "PGlite 건수를 못 읽음"; }
same "$WORK/counts-dump.txt" "$WORK/counts-pglite.txt" || die "이관 건수가 덤프와 다름"
ok "이관 끝 · 건수 일치 · $(head -1 "$WORK/import.log")"

# ------------------------------------------------------------------ 5. 새 서버
bold "5. 새 서버 시작 (PGlite)"
UNDO="$PILO stop
mv $HOME_DIR/data $HOME_DIR/data.failed-$STAMP     # 전환 뒤 쌓인 요청·답은 여기에만 남음
git -C $REPO reset --hard $MAIN_BEFORE && (cd $REPO && npm ci)
$PILO up        # Postgres 로 복귀"
"$PILO" up >/dev/null || die "서버 시작 실패 — tail -50 $HOME_DIR/logs/pilo.log"
check_start || die "새 서버 확인 실패 — 위 ! 줄"
ok "서버 동작 · port $PORT"

# ------------------------------------------------------------------ 6. 규칙
bold "6. 규칙 재생성 (에이전트 파일 쓰고 각 세션에 알림)"
ids="$(api /api/agents | python3 -c 'import sys, json; print(" ".join(str(a["id"]) for a in json.load(sys.stdin) if a.get("role") != "system" and a.get("cwd")))')"
failed=""; written=0
for id in $ids; do
  if curl -fsS -X POST "http://127.0.0.1:$PORT/api/agents/$id/rules" -o "$WORK/rules-$id.json" 2>/dev/null; then
    written=$((written + 1))
    python3 -c 'import sys, json; d = json.load(open(sys.argv[1])); print("    %-3s %s%s" % (sys.argv[2], d["file"].replace(sys.argv[3], "~"), "" if d.get("notified") else "  (알림 못 보냄: %s)" % d.get("reason", "")))' "$WORK/rules-$id.json" "$id" "$HOME"
  else
    failed="$failed $id"
  fi
done
if [ -z "$failed" ]; then ok "규칙 ${written}개 모두 씀"
else warn "실패한 에이전트:$failed — curl -X POST http://127.0.0.1:$PORT/api/agents/<id>/rules 로 다시"; fi

# ------------------------------------------------------------------ 7. 확인
bold "7. 자동 확인 (못 읽는 항목은 ! 로 적고 계속 — 전환 자체는 끝난 상태)"
check_after

bold "전환 끝 — 이제 손으로"
info "1) TUI 다시 열기:            pilo"
info "2) 대시보드 탭 새로고침"
info "3) 절차서 8단계 확인 목록 · 다시 확인: $0 --check"
info "4) 하루 써보고 문제 없으면:  docker stop $CONTAINER   (지우지 말 것)"
info ""
info "되돌리기가 필요하면:"
printf '%s\n' "$UNDO" | sed 's/^/      /'
info "작업 폴더: $WORK  (덤프 pilo.sql · pilo.pgdump · 건수 · 로그)"
