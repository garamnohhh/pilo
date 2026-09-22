// Agent-facing CLI. Talks to the Pilo API over the unix socket so it works with
// sandbox network access turned off.
import { request } from "node:http";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { socketPath, socketFile, home } from "./paths.js";
import { spoolDir, ensureSpool } from "./spool.js";
import { CLI_COMMANDS } from "./commands.js";
import { cols } from "./width.js";
import { t } from "./text.js";
import { describeCadence } from "./cadence.js";

function resolveSocket() {
  if (process.env.PILO_SOCKET) return process.env.PILO_SOCKET;
  if (existsSync(socketPath)) return socketPath;
  if (existsSync(socketFile)) {
    const recorded = readFileSync(socketFile, "utf8").trim();
    if (recorded && existsSync(recorded)) return recorded;
  }
  return socketPath;
}

// Used when the sandbox refuses the socket: drop a request file, wait for the reply file.
function viaSpool(method, path, body, timeoutMs = 15000) {
  ensureSpool();
  const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(join(spoolDir, `req-${id}.json`), JSON.stringify({ method, path, body }));
  const resFile = join(spoolDir, `res-${id}.json`);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let raw;
      try {
        raw = readFileSync(resFile, "utf8");
      } catch {
        if (Date.now() > deadline) {
          return reject(new Error(`no answer from the Pilo server (spool ${spoolDir}). is it up? try 'pilo up'.`));
        }
        return setTimeout(poll, 120);
      }
      try {
        unlinkSync(resFile);
      } catch {}
      const { status, payload } = JSON.parse(raw);
      if (status >= 400) return reject(new Error(payload.error || `HTTP ${status}`));
      resolve(payload);
    };
    poll();
  });
}

function viaSocket(method, path, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: resolveSocket(),
        path,
        method,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            return reject(new Error(`bad response: ${text.slice(0, 200)}`));
          }
          if (res.statusCode >= 400) return reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          resolve(parsed);
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// EINVAL is what a socket path longer than the platform's limit answers with —
// a sandbox temp directory reaches that on its own — and ENAMETOOLONG says the
// same thing outright. Both mean the socket cannot be used, not that the call
// should die on an errno.
const BLOCKED = new Set(["EPERM", "EACCES", "ENOENT", "ECONNREFUSED", "EINVAL", "ENAMETOOLONG"]);

async function call(method, path, body) {
  try {
    return await viaSocket(method, path, body);
  } catch (err) {
    if (!BLOCKED.has(err.code)) throw err;
    // Socket unavailable (sandbox or server down) — try the file spool.
    return viaSpool(method, path, body);
  }
}

const out = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

function flags(args) {
  const rest = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) opts[args[i].slice(2)] = args[++i];
    else rest.push(args[i]);
  }
  return { rest, opts };
}

// Long text does not belong on a command line. An agent with a report to file
// reaches for "$(cat …)", and a shell substitution is something no permission
// rule can read ahead of time: the call then rests on whatever judges the
// command text, which has turned down instructions that were only ever a row in
// a local database. --file keeps the words in a file and the command short.
function body(text, opts) {
  if (!opts?.file) return text.join(" ");
  const read = readFileSync(opts.file, "utf8").replace(/\s+$/, "");
  if (!read) throw new Error(`${opts.file} is empty`);
  return read;
}

// A report the server will not take is work already done. dial wrote its #1975
// report four times into a server that had no such task and each attempt ended
// at "task not found" with the text gone. The report is written to disk first
// and the failure says how to file it again, so nothing has to be retyped.
async function file(taskId, payload) {
  try {
    return await call("POST", `/api/tasks/${taskId}/result`, payload);
  } catch (err) {
    const dir = join(home, "unsent");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `task-${taskId}-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(payload, null, 2));
    throw new Error(
      `${err.message}\n\nyour report is kept: ${path}\nfile it again with: pilo api POST /api/tasks/${taskId}/result --file ${path}`
    );
  }
}

// The catalogue in commands.js is the one list; this renders the CLI half of it.
// Korean summaries mean the column has to be measured in display width.
const signature = (x) => `pilo ${x.name}${x.args ? " " + x.args : ""}`;
const column = Math.max(...CLI_COMMANDS.map((x) => cols(signature(x)))) + 2;
const USAGE = [
  "pilo agent commands",
  "",
  ...CLI_COMMANDS.map((x) => `  ${signature(x)}${" ".repeat(column - cols(signature(x)))}${x.summary}`)
].join("\n");

const commands = {
  async inbox([id]) {
    if (id) return out(await call("GET", `/api/inbox/${id}`));
    const rows = await call("GET", "/api/inbox");
    if (!rows.length) return out(t("cli.inboxEmpty"));
    return out(
      rows
        .map((r) => `in-${r.id} [${r.status}] ${r.userRequest.replace(/\s+/g, " ").slice(0, 70)}${r.routed ? ` → ${r.routed}` : ""}`)
        .join("\n")
    );
  },

  async schedules() {
    const rows = await call("GET", "/api/schedules");
    if (!rows.length) return out("no schedules");
    return out(rows.map((s) =>
      `${s.id}\t${s.enabled ? "on " : "off"}\t${describeCadence(s.cadence, s.weekdaysOnly, t)}\t→ ${s.agent || "watcher"}\t${s.kind === "system" ? (s.lastResult || "—") : new Date(s.nextRunAt).toLocaleString()}\t${s.name}`
    ).join("\n"));
  },

  async schedule(args) {
    const [id, verb] = args;
    if (!id || !["on", "off", "rm"].includes(verb)) throw new Error("usage: pilo schedule <id> on|off|rm");
    if (verb === "rm") return out(await call("DELETE", `/api/schedules/${id}`));
    return out(await call("POST", `/api/schedules/${id}`, { enabled: verb === "on" }));
  },

  async agents() {
    const rows = await call("GET", "/api/agents");
    if (!rows.length) return out(t("cli.noAgents"));
    return out(
      rows
        .map((a) => `${a.id}\t${a.name}\t${a.role}\t${a.projectName || "—"}\t${a.aliases || ""}`)
        .join("\n")
    );
  },

  async send(args) {
    const { rest, opts } = flags(args);
    const [agentId, inboxId, ...text] = rest;
    if (!agentId || !inboxId || (!text.length && !opts.file)) throw new Error("usage: pilo send <agentId> <inboxId> <request> | --file <path>");
    const request = body(text, opts);
    const res = await call("POST", `/api/inbox/${inboxId}/tasks`, {
      toAgentId: Number(agentId),
      title: opts.title || request.split("\n")[0].slice(0, 40),
      request
    });
    return out(t("cli.taskSent", { id: res.id, agent: agentId }));
  },

  async reply(args) {
    // A switch with no value, so it may sit anywhere after the id.
    const attach = args.includes("--with-results");
    const { rest, opts } = flags(args.filter((arg) => arg !== "--with-results"));
    const [inboxId, ...text] = rest;
    if (!inboxId || (!text.length && !attach && !opts.file)) throw new Error("usage: pilo reply <inboxId> <text> [--with-results] | --file <path>");
    const res = await call("POST", `/api/inbox/${inboxId}/reply`, { body: body(text, opts), withResults: attach });
    const saved = t("cli.replySaved", { id: res.id, inbox: inboxId });
    return out(res.attached?.length ? saved + t("cli.replyAttached", { agents: res.attached.join(", ") }) : saved);
  },

  async history(args) {
    const { rest, opts } = flags(args);
    if (!rest.length) throw new Error("usage: pilo history <words…> [--since YYYY-MM-DD] [--agent name] [--limit N]");
    const params = new URLSearchParams({ q: rest.join(" ") });
    for (const key of ["since", "agent", "limit"]) if (opts[key]) params.set(key, opts[key]);
    const res = await call("GET", `/api/history?${params}`);
    if (!res.rows.length) return out(t("cli.historyNone", { words: res.words.join(" ") }));
    const label = (m) => `${t(`history.${m.field}`)}${m.agent ? `(${m.agent})` : ""}`;
    return out([
      ...res.rows.map((row) => [
        `in-${row.id} · ${row.at} KST${row.agents.length ? ` · ${row.agents.join(", ")}` : ""}`,
        ...row.matches.map((m) => `  ${label(m)}: ${m.text}`)
      ].join("\n")),
      res.more ? t("cli.historyMore", { count: res.rows.length }) : t("cli.historyEnd")
    ].join("\n"));
  },

  async task([id]) {
    if (!id) throw new Error("usage: pilo task <id>");
    return out(await call("GET", `/api/tasks/${id}`));
  },

  async progress(args) {
    const [taskId, ...text] = args;
    if (!taskId || !text.length) throw new Error("usage: pilo progress <taskId> <one line>");
    const res = await call("POST", `/api/tasks/${taskId}/progress`, { text: text.join(" ") });
    return out(t("cli.progressSaved", { id: res.id, text: res.progress }));
  },

  async done(args) {
    const { rest, opts } = flags(args);
    const [taskId, ...text] = rest;
    if (!taskId || (!text.length && !opts.file)) throw new Error("usage: pilo done <taskId> <report> | --file <path>");
    const res = await file(taskId, {
      pmResult: body(text, opts),
      status: opts.status || "done",
      error: opts.error || "",
      tokensIn: Number(opts.in || 0),
      tokensOut: Number(opts.out || 0),
      // what was checked and run: kept with the result, off the user's screen
      runLog: opts.log ? [{ t: "", text: opts.log }] : undefined
    });
    return out(t("cli.result", { id: res.id, status: res.status }));
  },

  async block(args) {
    const { rest, opts } = flags(args);
    const [taskId, ...text] = rest;
    if (!taskId || (!text.length && !opts.file)) throw new Error("usage: pilo block <taskId> <question> | --file <path> [--for <taskId>]");
    const question = body(text, opts);
    const res = await file(taskId, {
      pmResult: opts.note || question,
      question,
      // --for: this block carries that one's question up, so the user is asked once
      relayOf: opts.for ? Number(opts.for) : undefined,
      status: "blocked",
      tokensIn: Number(opts.in || 0),
      tokensOut: Number(opts.out || 0)
    });
    return out(t("cli.blocked", { id: res.id, status: res.status }));
  },

  async hold(args) {
    const [taskId, ...text] = args;
    if (!taskId) throw new Error("usage: pilo hold <taskId> <what you are waiting for>");
    const res = await call("POST", `/api/tasks/${taskId}/hold`, { note: text.join(" ") });
    return out(t("cli.holding", { id: res.id, note: res.note }));
  },

  async resume([taskId]) {
    if (!taskId) throw new Error("usage: pilo resume <taskId>");
    const res = await call("POST", `/api/tasks/${taskId}/resume`, {});
    return out(t("cli.resumed", { id: res.id }));
  },

  async limited(args) {
    const { rest, opts } = flags(args);
    const agentId = rest[0] || opts.agent;
    if (!agentId) throw new Error("usage: pilo limited <agentId> --until 2026-09-08T18:00:00Z  (omit --until to clear)");
    const res = await call("POST", `/api/agents/${agentId}/limited`, { until: opts.until || null });
    return out(res.limitedUntil ? t("cli.limited", { until: res.limitedUntil }) : t("cli.unlimited"));
  },

  async blocked() {
    const rows = await call("GET", "/api/blocked");
    if (!rows.length) return out(t("cli.noBlocked"));
    return out(rows.map((r) => `#${r.id} ${r.agent} · ${r.project || "—"}\n   ${r.question}`).join("\n"));
  },

  // the desk, to the user, about a task that waits on them — not the answer
  async ask(args) {
    const { rest, opts } = flags(args);
    const [taskId, ...text] = rest;
    if (!taskId || (!text.length && !opts.file)) throw new Error('usage: pilo ask <taskId> "what the user needs to decide or do" | --file <path>');
    const res = await call("POST", `/api/tasks/${taskId}/ask`, { body: body(text, opts) });
    return out(t("cli.asked", { id: res.taskId, inbox: res.inboxId }));
  },

  async answer(args) {
    const { rest, opts } = flags(args);
    const [taskId, ...text] = rest;
    if (!taskId || (!text.length && !opts.file)) throw new Error("usage: pilo answer <taskId> <answer> | --file <path>");
    const res = await call("POST", `/api/tasks/${taskId}/answer`, { body: body(text, opts) });
    return out(t("cli.answered", { id: res.id, status: res.status }));
  },

  async api(args) {
    const { rest, opts } = flags(args);
    const [method, path, json] = rest;
    if (!method || !path) throw new Error("usage: pilo api <METHOD> <path> [json] | --file <path.json>");
    const payload = opts.file ? readFileSync(opts.file, "utf8") : json;
    return out(await call(method.toUpperCase(), path, payload ? JSON.parse(payload) : undefined));
  }
};

const [name, ...args] = process.argv.slice(2);
const run = commands[name];
if (!run) {
  console.log(USAGE);
  process.exit(name ? 1 : 0);
}
try {
  await run(args);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
