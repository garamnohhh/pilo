// One catalogue for every command Pilo takes, so the TUI's help line, the CLI's
// usage text and the dashboard's Commands page can never drift apart.
//
// The prefix is a colon. A slash is still accepted for anyone with the habit,
// but nothing prints one. A message that merely starts with either — a path like
// /Users/you/... — is not a command: only a known word counts.
export const CATALOGUE = [
  { scope: "tui", name: "dash", aliases: ["dashboard"], args: "[tab]", summary: "open the dashboard", example: ":dash agents" },
  { scope: "tui", name: "agents", args: "", summary: "the agent tree in short", example: ":agents" },
  { scope: "tui", name: "inbox", args: "", summary: "requests with no answer yet", example: ":inbox" },
  { scope: "tui", name: "project", aliases: ["p"], args: "<name>|all", summary: "filter the feed by project", example: ":project web-app" },
  { scope: "tui", name: "blocked", args: "", summary: "tasks waiting on your decision", example: ":blocked" },
  { scope: "tui", name: "allow", args: "[n]", summary: "allow what a session asks - :allow once more to confirm", example: ":allow 1" },
  { scope: "tui", name: "deny", args: "[n]", summary: "deny what a session asks", example: ":deny" },
  { scope: "tui", name: "pane", args: "[n]", summary: "send it back to be answered in the session's pane", example: ":pane 2" },
  { scope: "tui", name: "pick", args: "<choice…> [n]", summary: "answer a session's question - one per question, several for a multi-select", example: ":pick 2" },
  { scope: "tui", name: "answer", args: "<taskId> <answer>", summary: "answer a decision - the task goes back in the queue", example: ':answer 481 "yes, ship it"' },
  { scope: "tui", name: "copy", args: "[last|in-N|task-N|draft]", summary: "copy an answer or your draft to the clipboard", example: ":copy in-42" },
  { scope: "tui", name: "icons", args: "[on|off]", summary: "runtime icons before agent names - letters without", example: ":icons on" },
  { scope: "tui", name: "mouse", args: "", summary: "mouse off/on - off lets the terminal select by drag", example: ":mouse" },
  { scope: "tui", name: "follow", aliases: ["f"], args: "[in-N|off]", summary: "follow up - your next message is tied to in-N; no number takes the latest answer · clicking an answer does the same · Esc cancels", example: ":follow in-812" },
  { scope: "tui", name: "fold", args: "[id|all|default]", summary: "fold answers", example: ":fold all" },
  { scope: "tui", name: "unfold", args: "", summary: "unfold everything", example: ":unfold" },
  { scope: "tui", name: "cost", args: "", summary: "token use", example: ":cost" },
  { scope: "tui", name: "schedules", aliases: ["sched"], args: "", summary: "scheduled jobs", example: ":schedules" },
  { scope: "tui", name: "schedule", args: "<id> on|off|rm", summary: "turn a schedule on/off or remove it", example: ":schedule 3 off" },
  { scope: "tui", name: "help", args: "", summary: "the command list", example: ":help" },
  { scope: "tui", name: "exit", aliases: ["q", "quit"], args: "", summary: "quit", example: ":exit" },

  { scope: "cli", name: "inbox", args: "[id]", summary: "requests with no answer yet; with an id, its words and its tasks", example: "pilo inbox 42" },
  { scope: "cli", name: "agents", args: "", summary: "registered agents (id · name · role · project)", example: "pilo agents" },
  { scope: "cli", name: "send", args: "<agentId> <inboxId> <request>|--file <path>", summary: "make a task for a PM", example: 'pilo send 3 42 "fix the login redirect"' },
  { scope: "cli", name: "reply", args: "<inboxId> <text>|--file <path> [--with-results]", summary: "save the final_reply - --with-results adds each PM's result under the lead", example: 'pilo reply 42 "Fixed. Needs a restart." --with-results' },
  { scope: "cli", name: "history", args: "<words…> [--since date] [--agent name]", summary: "find past requests, answers and results - newest first, in pieces", example: "pilo history invoice --since 2026-09-01" },
  { scope: "cli", name: "task", args: "<id>", summary: "a task's request in full and the user's own words", example: "pilo task 301" },
  { scope: "cli", name: "progress", args: "<taskId> <one line>", summary: "progress - apart from the final answer, as often as you like", example: 'pilo progress 301 "reproducing on staging"' },
  { scope: "cli", name: "done", args: "<taskId> <report>|--file <path> [--log what you checked]", summary: "report a task's result - what you checked and ran goes in --log", example: 'pilo done 301 "Done" --log "42 tests pass" --in 12000 --out 3000' },
  { scope: "cli", name: "block", args: "<taskId> <question> [--for <taskId>]", summary: "mark a task as waiting on the user's decision", example: 'pilo block 301 "Publish the pricing page today?"' },
  { scope: "cli", name: "blocked", args: "", summary: "tasks waiting on a decision", example: "pilo blocked" },
  { scope: "cli", name: "ask", args: "<taskId> <words to the user> [--option <choice> …]", summary: "desk → user: a waiting task as a red line in that conversation - not an answer. Buttons only for each --option", example: 'pilo ask 301 "Decide whether the pricing page goes out today" --option "publish" --option "hold"' },
  { scope: "cli", name: "hold", args: "<taskId> <what you wait on>", summary: "waiting on something outside Pilo", example: 'pilo hold 812 "waiting on CI"' },
  { scope: "cli", name: "resume", args: "<taskId>", summary: "back into the queue", example: "pilo resume 812" },
  { scope: "cli", name: "limited", args: "<agentId> --until <time>", summary: "report a usage limit (omit --until to clear)", example: "pilo limited 6 --until 2026-09-08T18:00:00Z" },
  { scope: "cli", name: "answer", args: "<taskId> <answer>", summary: "answer a decision - the task goes back in the queue", example: 'pilo answer 301 "yes"' },
  { scope: "cli", name: "schedules", args: "", summary: "schedules (id · next run · target)", example: "pilo schedules" },
  { scope: "cli", name: "schedule", args: "<id> on|off|rm", summary: "turn a schedule on/off or remove it", example: "pilo schedule 3 off" },
  { scope: "cli", name: "api", args: "<METHOD> <path> [json]", summary: "any other endpoint", example: "pilo api GET /api/overview" }
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
