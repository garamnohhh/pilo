// One catalogue for every command Pilo takes, so the TUI's help line, the CLI's
// usage text and the dashboard's Commands page can never drift apart.
//
// The prefix is a colon. A slash is still accepted for anyone with the habit,
// but nothing prints one. A message that merely starts with either — a path like
// /Users/you/... — is not a command: only a known word counts.
export const CATALOGUE = [
  { scope: "tui", name: "dash", aliases: ["dashboard"], args: "[탭]", summary: "대시보드 열기", example: ":dash agents" },
  { scope: "tui", name: "agents", args: "", summary: "agent tree 요약", example: ":agents" },
  { scope: "tui", name: "inbox", args: "", summary: "아직 답변이 없는 요청", example: ":inbox" },
  { scope: "tui", name: "project", aliases: ["p"], args: "<이름>|all", summary: "프로젝트로 피드 거르기", example: ":project web-app" },
  { scope: "tui", name: "blocked", args: "", summary: "사용자 결정을 기다리는 작업", example: ":blocked" },
  { scope: "tui", name: "answer", args: "<taskId> <답변>", summary: "결정 회신 — 그 작업이 다시 큐로", example: ':answer 481 "yes, ship it"' },
  { scope: "tui", name: "copy", args: "[last|in-N|task-N|draft]", summary: "답변이나 입력 중인 글을 클립보드로", example: ":copy in-42" },
  { scope: "tui", name: "icons", args: "[on|off]", summary: "agent 이름 앞 runtime 아이콘 — 없으면 글자 라벨", example: ":icons on" },
  { scope: "tui", name: "mouse", args: "", summary: "마우스 끄기/켜기 — 끄면 터미널 드래그 선택", example: ":mouse" },
  { scope: "tui", name: "fold", args: "[id|all|default]", summary: "답변 접기", example: ":fold all" },
  { scope: "tui", name: "unfold", args: "", summary: "접은 것 모두 펼치기", example: ":unfold" },
  { scope: "tui", name: "cost", args: "", summary: "토큰 사용량", example: ":cost" },
  { scope: "tui", name: "schedules", aliases: ["sched"], args: "", summary: "예약된 정기 작업", example: ":schedules" },
  { scope: "tui", name: "schedule", args: "<id> on|off|rm", summary: "예약 켜기/끄기/삭제", example: ":schedule 3 off" },
  { scope: "tui", name: "help", args: "", summary: "명령 목록", example: ":help" },
  { scope: "tui", name: "exit", aliases: ["q", "quit"], args: "", summary: "종료", example: ":exit" },

  { scope: "cli", name: "inbox", args: "[id]", summary: "미처리 요청 목록, id를 주면 원문과 task 상태", example: "pilo inbox 42" },
  { scope: "cli", name: "agents", args: "", summary: "등록된 agent (id · name · role · project)", example: "pilo agents" },
  { scope: "cli", name: "send", args: "<agentId> <inboxId> <요청>", summary: "PM에게 task 생성", example: 'pilo send 3 42 "로그인 리다이렉트 고쳐줘"' },
  { scope: "cli", name: "reply", args: "<inboxId> <본문>", summary: "final_reply 저장 — 사용자 화면에 뜨는 유일한 값", example: 'pilo reply 42 "고쳤습니다"' },
  { scope: "cli", name: "task", args: "<id>", summary: "받은 작업의 요청 전문과 사용자 원문", example: "pilo task 301" },
  { scope: "cli", name: "progress", args: "<taskId> <한 줄>", summary: "진행 상황 — 최종 답변과 별개, 여러 번 가능", example: 'pilo progress 301 "스테이징에서 재현 중"' },
  { scope: "cli", name: "done", args: "<taskId> <보고>", summary: "작업 결과 보고", example: 'pilo done 301 "완료" --in 12000 --out 3000' },
  { scope: "cli", name: "block", args: "<taskId> <질문>", summary: "사용자 결정 대기로 표시", example: 'pilo block 301 "가격 페이지 오늘 공개할까요?"' },
  { scope: "cli", name: "blocked", args: "", summary: "결정 대기 중인 작업 목록", example: "pilo blocked" },
  { scope: "cli", name: "hold", args: "<taskId> <what you wait on>", summary: "waiting on something outside Pilo", example: 'pilo hold 812 "waiting on CI"' },
  { scope: "cli", name: "resume", args: "<taskId>", summary: "back into the queue", example: "pilo resume 812" },
  { scope: "cli", name: "limited", args: "<agentId> --until <time>", summary: "report a usage limit (omit --until to clear)", example: "pilo limited 6 --until 2026-09-08T18:00:00Z" },
  { scope: "cli", name: "answer", args: "<taskId> <답변>", summary: "결정 회신 — 그 작업이 다시 큐로", example: 'pilo answer 301 "네"' },
  { scope: "cli", name: "schedules", args: "", summary: "예약 목록 (id · 다음 실행 · 대상)", example: "pilo schedules" },
  { scope: "cli", name: "schedule", args: "<id> on|off|rm", summary: "예약 켜기/끄기/삭제", example: "pilo schedule 3 off" },
  { scope: "cli", name: "api", args: "<METHOD> <path> [json]", summary: "그 외 모든 엔드포인트", example: "pilo api GET /api/overview" }
];

export const TUI_COMMANDS = CATALOGUE.filter((x) => x.scope === "tui");
export const CLI_COMMANDS = CATALOGUE.filter((x) => x.scope === "cli");

export const COMMANDS = Object.fromEntries(TUI_COMMANDS.map((x) => [x.name, x.aliases || []]));

const LOOKUP = new Map();
for (const entry of TUI_COMMANDS) {
  LOOKUP.set(entry.name, entry.name);
  for (const alias of entry.aliases || []) LOOKUP.set(alias, entry.name);
}

export function parseCommand(text) {
  const raw = String(text || "");
  if (!/^[/:]/.test(raw)) return null;
  const body = raw.slice(1).trim();
  if (!body) return null;
  const [word, ...rest] = body.split(/\s+/);
  const name = LOOKUP.get(word.toLowerCase());
  if (!name) return null;
  return { name, args: rest };
}

export const HELP = TUI_COMMANDS.map((x) => `:${x.name}${x.args ? " " + x.args : ""} ${x.summary}`).join("   ");

// A mistyped command looks exactly like a message, and a message that reaches
// the desk agent costs it a round trip to answer. So a near-miss is caught
// before it is sent — but only a near-miss: anything that could be a sentence
// goes through untouched.
//
// Candidate rules, deliberately narrow:
//   · one word, no spaces — ":오늘 일정 알려줘" is a message
//   · ASCII letters and dashes only — ":안녕하세요" is a message
//   · 3 to 16 characters — ":a" is too short to guess from
//   · within one edit for three letters, two for longer
function distance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return rows[a.length][b.length];
}

export function suggest(text) {
  const raw = String(text || "");
  if (!/^[/:]/.test(raw)) return null;
  const word = raw.slice(1).trim();
  if (!/^[a-zA-Z][a-zA-Z-]{2,15}$/.test(word)) return null;
  if (parseCommand(raw)) return null;

  const typed = word.toLowerCase();
  const limit = typed.length <= 3 ? 1 : 2;
  const names = TUI_COMMANDS.flatMap((x) => [x.name, ...(x.aliases || [])]);
  const near = names
    .map((name) => ({ name, gap: distance(typed, name) }))
    .filter((x) => x.gap <= limit)
    .sort((a, b) => a.gap - b.gap || a.name.localeCompare(b.name));
  if (!near.length) return null;
  const best = near.filter((x) => x.gap === near[0].gap).slice(0, 2);
  return { word, matches: best.map((x) => x.name) };
}
