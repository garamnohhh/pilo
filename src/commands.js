// Slash commands, with the old colon form kept as an alias.
//
// A message that merely starts with a slash — a path like /Users/garam/... — is
// not a command. Only a known word counts, everything else is sent as text.
export const COMMANDS = {
  exit: ["q", "quit"],
  dash: ["dashboard"],
  agents: [],
  inbox: [],
  project: ["p"],
  blocked: [],
  answer: [],
  copy: [],
  mouse: [],
  fold: [],
  unfold: [],
  cost: [],
  help: []
};

const LOOKUP = new Map();
for (const [name, aliases] of Object.entries(COMMANDS)) {
  LOOKUP.set(name, name);
  for (const alias of aliases) LOOKUP.set(alias, name);
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

export const HELP = [
  "/dash 대시보드",
  "/agents agent tree",
  "/inbox 미처리 요청",
  "/project <이름>|all 필터",
  "/blocked 결정 대기",
  "/answer <id> <답변>",
  "/copy [last|in-N|task-N|draft]",
  "/mouse 선택 복사 모드",
  "/fold [id|all|default]",
  "/unfold",
  "/cost 토큰",
  "/exit 종료"
].join("   ");
