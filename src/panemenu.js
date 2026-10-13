// A numbered choice a pane is showing — Claude Code's "Do you want to proceed?
// 1. Yes 2. No", a question with options, Codex's approval list — read off the
// screen so the dashboard can offer the same numbers as buttons. Read-only: what
// is sent back is one digit, and only while the screen still shows exactly this.
import { createHash } from "node:crypto";

const OPTION = /^\s*(?:[❯›>▶]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
const RULE = /^[\s─━╌┄═\-_│|]*$/;
const HINT = /(Esc to cancel|Enter to select|Tab to amend|↑\/↓|to navigate|\(esc\)$)/i;
// a choice that hands out more than this one request: a standing rule or a mode
// switch is made in the pane, by the person who will live with it
const STANDING = /\b(always|don'?t ask again|do not ask again|from now on|for this session|auto[- ]?mode|bypass)\b/i;

const TYPED = /^(type something|chat about this|other)\b/i;

export function parseMenu(screen) {
  const lines = String(screen || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n").slice(-60);
  // the last run of options numbered 1, 2, 3 … with only indented notes between
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (OPTION.test(lines[i])) { end = i; break; }
  if (end < 0) return null;
  const options = [];
  let start = end;
  for (let i = end; i >= 0; i--) {
    const m = OPTION.exec(lines[i]);
    if (m) {
      options.unshift({ n: Number(m[1]), label: m[2].replace(/\s+\((?:[a-z]|esc|enter|tab)\)$/i, "").trim() });
      start = i;
      if (m[1] === "1") break;
      continue;
    }
    // a description under an option is indented further, and a rule may split
    // the list (Claude puts one above "Chat about this"); anything else ends it
    if (RULE.test(lines[i]) && lines[i].trim()) continue;
    if (!/^\s{3,}\S/.test(lines[i])) return null;
  }
  if (options[0]?.n !== 1 || options.some((o, i) => o.n !== i + 1) || options.length < 2) return null;
  // the question: the nearest line above that says something
  let question = "";
  const context = [];
  for (let i = start - 1; i >= Math.max(0, start - 14); i--) {
    const text = lines[i].replace(/^[\s│|☐☑✔]+/, "").trim();
    if (!text || RULE.test(lines[i]) || HINT.test(text)) { if (question && context.length) break; continue; }
    if (!question) question = text;
    else context.unshift(text);
    if (context.length >= 6) break;
  }
  if (!question) return null;
  // "Type something." and "Chat about this" want words typed in the pane
  const choices = options.map((o) => ({ ...o, standing: STANDING.test(o.label), typed: TYPED.test(o.label) }));
  return { question, context, options: choices, fingerprint: menuPrint(question, choices) };
}

// what the menu says, not where its cursor is: moving the pointer is no change
export const menuPrint = (question, options) => createHash("sha256")
  .update([question, ...options.map((o) => `${o.n}.${o.label}`)].join("\u001f")).digest("hex").slice(0, 24);
