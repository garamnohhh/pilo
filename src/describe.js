// What a request is about, in words, for a card on the dashboard. Claude Code's
// Bash tool writes a line of its own for every command (tool_input.description)
// and that comes first; Codex writes none, so the command is read with a few
// plain rules, no model call. The result is keys and values, put into words by
// the screen in the user's language.
import { heredocs, simpleCommands, words, windowOnly, tempVarsOf, isTempPath } from "../hooks/pilo-hook.mjs";

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
