// What a request is about, in words, for a card on the dashboard. Claude Code's
// Bash tool writes a line of its own for every command (tool_input.description)
// and that comes first; Codex writes none, so the command is read with a few
// plain rules, no model call. The result is keys and values, put into words by
// the screen in the user's language.
import { heredocs, simpleCommands, words, windowOnly, tempVarsOf, isTempPath } from "../hooks/pilo-hook.mjs";
import { tUser } from "./text.js";

const SKIP = new Set(["cd", "echo", "printf", "true", "false", "set", "export", "sleep", "wait", "test", "[", ":"]);
const short = (s, n = 60) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const base = (w) => String(w || "").split("/").pop();


const VALUE_FLAGS = new Set(["-v", "-w", "-e", "-p", "-u", "--name", "--network", "--mount", "--env", "--workdir", "--volume", "--platform", "--user", "--entrypoint"]);

function step(segment, temps) {
  // redirections are not arguments
  let w = words(segment.replace(/\d*[<>]+&?\d*\s*(\S+)?/g, (m) => (/&\d$/.test(m.trim()) ? "" : ""))).filter(Boolean);
  while (w.length && /^[A-Za-z_]\w*=/.test(w[0])) w = w.slice(1);
  const cmd = base(w[0]);
  const args = w.slice(1);
  const plain = args.filter((a) => !a.startsWith("-"));
  if (!cmd || SKIP.has(cmd)) return null;
  if (cmd === "sudo" || cmd === "env" || cmd === "nohup" || cmd === "time") return args.length ? step(args.join(" "), temps) : null;
  if (cmd === "git") {
    const sub = plain[0] || "";
    if (sub === "clone") return { key: "git.clone", arg: short(plain.find((a) => /[:/]/.test(a)) || "") };
    if (sub === "push") return { key: args.some((a) => /^--force|^-f$/.test(a)) ? "git.forcePush" : "git.push", arg: plain.slice(1).join(" ") };
    if (sub === "commit") return { key: "git.commit" };
    if (sub === "reset" && args.includes("--hard")) return { key: "git.resetHard" };
    return { key: "git.other", arg: sub };
  }
  if (cmd === "docker" && plain[0] === "run") {
    const rest = args.slice(args.indexOf("run") + 1);
    let image = "";
    for (let i = 0; i < rest.length; i++) {
      if (VALUE_FLAGS.has(rest[i])) { i++; continue; }
      if (rest[i].startsWith("-")) continue;
      image = rest[i];
      break;
    }
    return { key: "docker.run", arg: short(image) };
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(cmd)) {
    const sub = plain[0] || "install";
    if (["install", "i", "ci", "add"].includes(sub)) return { key: "npm.install" };
    if (sub === "publish") return { key: "npm.publish" };
    if (sub === "test") return { key: "npm.test" };
    if (sub === "run") return { key: "npm.run", arg: plain[1] || "" };
    return { key: "run", arg: `${cmd} ${sub}` };
  }
  if (cmd === "rm") {
    // the same test the hook uses, so a card never calls temporary what it does not
    const targets = plain.map((t) => {
      const v = /^\$\{?([A-Za-z_]\w*)/.exec(t);
      return { path: short(t, 50), temp: isTempPath(t, temps), made: Boolean(v && temps.made?.has(v[1])) };
    });
    return { key: "rm", targets };
  }
  if (cmd === "mktemp") return { key: "mktemp" };
  if (cmd === "cargo") return { key: ["build", "test", "run", "check", "clippy"].includes(plain[0]) ? `cargo.${plain[0]}` : "run", arg: `cargo ${plain[0] || ""}`.trim() };
  // "gh 실행" said nothing; the subcommand does (gh secret list)
  if (cmd === "gh" || cmd === "aws" || cmd === "kubectl" || cmd === "gcloud") return { key: "run", arg: short([cmd, ...plain.slice(0, 2)].join(" ")) };
  if (cmd === "ssh") return { key: "run", arg: short(`ssh ${plain[0] || ""}: ${plain.slice(1).join(" ")}`) };
  if (cmd === "curl" || cmd === "wget") return { key: "download", arg: short(plain.find((a) => /^https?:/.test(a)) || "") };
  if (/^python3?$/.test(cmd)) return { key: "python", arg: plain[0] && plain[0] !== "-" ? base(plain[0]) : "" };
  if (cmd === "node" || cmd === "swift" || cmd === "ruby" || cmd === "osascript") return { key: "script", arg: cmd };
  if (cmd === "cat" && /(^|[^>])>[^>]?\s*\S/.test(segment)) return { key: "write", arg: short((/>\s*(\S+)/.exec(segment) || [])[1] || "") };
  if (cmd === "pilo") return { key: "pilo", arg: plain.slice(0, 2).join(" ") };
  if (["psql", "mysql", "sqlite3"].includes(cmd)) return { key: "db", arg: cmd };
  if (cmd === "sketchybar") return { key: "sketchybar" };
  if (["ls", "cat", "head", "tail", "grep", "rg", "find", "wc", "sed", "awk", "jq"].includes(cmd)) return { key: "read" };
  return { key: "run", arg: cmd };
}

// { line, steps, file, danger }: line is the tool's own sentence when it wrote one
export function describe(tool, input = {}) {
  const out = { line: "", steps: [], file: null, danger: null };
  if (typeof input?.description === "string" && input.description.trim()) out.line = input.description.trim();
  const command = Array.isArray(input?.command) ? input.command.join(" ") : String(input?.command ?? "");
  if (command) {
    const temps = tempVarsOf(command);
    // which of them $(mktemp) just made, for "a temporary folder made just now"
    temps.made = new Set([...String(command).matchAll(/\b([A-Za-z_]\w*)=["']?\$\(\s*mktemp\b/g)].map((m) => m[1]));
    const seen = new Set();
    for (const part of heredocs(command)) {
      for (const segment of simpleCommands(part)) {
        const s = step(segment, temps);
        if (!s) continue;
        const id = s.key + (s.arg || "") + JSON.stringify(s.targets || "");
        if (seen.has(id) || (s.key === "read" && seen.has("read"))) continue;
        seen.add(id);
        if (s.key === "read") seen.add("read");
        out.steps.push(s);
      }
    }
    // a $(mktemp) is read after the command around it, but it happens first
    out.steps.sort((a, b) => (b.key === "mktemp") - (a.key === "mktemp"));
    out.steps = out.steps.slice(0, 6);
  }
  const path = input?.file_path ?? input?.notebook_path;
  if (path) {
    const lines = (t) => (t ? String(t).split("\n").length : 0);
    if (tool === "Write") out.file = { kind: "new", path, added: lines(input.content) };
    else if (tool === "Edit") out.file = { kind: "edit", path, removed: lines(input.old_string), added: lines(input.new_string) };
    else if (tool === "MultiEdit") out.file = { kind: "edit", path, edits: (input.edits || []).length };
    else out.file = { kind: tool === "Read" ? "read" : "other", path };
  }
  const rule = windowOnly(tool, input);
  if (rule) out.danger = { rule, targets: out.steps.filter((s) => s.key === "rm").flatMap((s) => s.targets) };
  return out;
}

// #5989: what a card asks, as one plain sentence for whoever reads it - the
// agent, and what it wants to do, in words: "pilo-dev가 Rust 프로그램을 빌드해도
// 될까요?". No guide lines, no English original. Each step's phrase is a verb
// stem ending in 하 (plain.step.*), so they chain with 고 and the last takes 해도.
// The options keep their numbers; Yes and No read as 진행 and 멈춤.
const RISK = { "rm -rf": "delete", "git push --force": "force", "delete remote": "delete", "database write": "db", "cloud change": "cloud",
  "account write": "account", "outside message": "outside", ".env / secrets": "secret", "pilo approvals": "pilo" };
const filename = (p) => String(p || "").split("/").filter(Boolean).pop() || String(p || "");

function stepPhrase(s) {
  if (s.key === "rm") {
    const what = s.targets.map((t) => (t.temp ? tUser("plain.tempOf", { path: t.path }) : t.path)).join(", ");
    return tUser("plain.step.rm", { what: what || tUser("plain.someFiles") });
  }
  const key = `plain.step.${s.key}`;
  const line = tUser(key, { arg: s.arg || "" });
  return line === key ? tUser("plain.step.run", { arg: s.arg || s.key }) : line;
}

export function plainAsk(item, menu = null) {
  const who = item?.agent || "agent";
  const tool = item?.tool || "";
  const input = item?.input || {};
  let line;
  if (item?.kind === "question") line = tUser("plain.question", { who });
  else if (!tool) line = tUser("plain.unread");
  else if (tool === "Bash" || tool === "exec_command" || input.command) {
    // looking at output (tail, grep) says nothing next to what the command does
    const all = describe(tool, input).steps;
    const doing = all.filter((x) => x.key !== "read");
    const steps = (doing.length ? doing : all).slice(0, 3).map(stepPhrase);
    if (!steps.length) line = tUser("plain.unread");
    else {
      // 하 + 고 for all but the last; the last 하 becomes 해도
      const chain = steps.map((p, i) => (i < steps.length - 1 ? `${p}고` : `${p.slice(0, -1)}해도`)).join(", ");
      line = tUser("plain.ask", { who, what: chain });
    }
  } else if (["Edit", "MultiEdit", "NotebookEdit"].includes(tool)) line = tUser("plain.edit", { who, file: filename(input.file_path || input.notebook_path) });
  else if (tool === "Write") line = tUser("plain.write", { who, file: filename(input.file_path) });
  else if (tool === "Read") line = tUser("plain.read", { who, file: filename(input.file_path) });
  else if (tool === "WebFetch") line = tUser("plain.web", { who, where: (/^https?:\/\/([^/]+)/.exec(String(input.url || "")) || [])[1] || String(input.url || "") });
  else if (tool === "WebSearch") line = tUser("plain.search", { who, what: String(input.query || "") });
  else if (/^mcp__/.test(tool)) { const [, server, fn] = tool.split("__"); line = tUser("plain.mcp", { who, server, fn: fn || "" }); }
  else line = tUser("plain.tool", { who, tool });
  const why = item?.reason || item?.risk || "";
  if (why && RISK[why]) line += ` ${tUser(`plain.risk.${RISK[why]}`)}`;
  const options = (menu?.options || []).map((o) => ({ n: o.n, label: /^yes\b/i.test(o.label) && !o.standing ? tUser("plain.go") : /^no\b/i.test(o.label) ? tUser("plain.stop") : o.label }));
  return { line, options };
}
