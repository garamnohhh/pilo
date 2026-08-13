// Agent-facing CLI. Talks to the Pilo API over the unix socket so it works with
// sandbox network access turned off.
import { request } from "node:http";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { socketPath, socketFile } from "./paths.js";
import { spoolDir, ensureSpool } from "./spool.js";

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
          return reject(new Error(`Pilo 서버 응답 없음 (spool ${spoolDir}). 'pilo up' 으로 띄웠는지 확인하세요.`));
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

const BLOCKED = new Set(["EPERM", "EACCES", "ENOENT", "ECONNREFUSED"]);

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

const USAGE = `pilo agent commands

  pilo inbox                    미처리 요청 목록
  pilo inbox <id>               요청 원문과 task/최종답변 상태
  pilo agents                   등록된 agent 목록 (id, name, role)
  pilo send <agentId> <inboxId> <요청>   PM에게 task 생성  [--title 제목]
  pilo reply <inboxId> <본문>   final_reply 저장 (사용자 화면에 뜨는 유일한 값)
  pilo task <id>                받은 작업 원문
  pilo progress <taskId> <한 줄>  진행 상황 남기기 (최종 답변과 별개, 여러 번 가능)
  pilo done <taskId> <보고>     작업 결과 보고  [--in 토큰 --out 토큰 --status done|failed]
  pilo block <taskId> <질문>    사용자 결정 대기로 표시 (spinner 대신 '결정 대기')
  pilo blocked                  결정 대기 중인 작업 목록
  pilo answer <taskId> <답변>   결정 회신 — 그 작업이 다시 큐로 돌아감
  pilo api <METHOD> <path> [json]        그 외 모든 엔드포인트`;

const commands = {
  async inbox([id]) {
    if (id) return out(await call("GET", `/api/inbox/${id}`));
    const rows = await call("GET", "/api/inbox");
    if (!rows.length) return out("inbox 비어 있음");
    return out(
      rows
        .map((r) => `in-${r.id} [${r.status}] ${r.userRequest.replace(/\s+/g, " ").slice(0, 70)}${r.routed ? ` → ${r.routed}` : ""}`)
        .join("\n")
    );
  },

  async agents() {
    const rows = await call("GET", "/api/agents");
    if (!rows.length) return out("등록된 agent 없음");
    return out(
      rows
        .map((a) => `${a.id}\t${a.name}\t${a.role}\t${a.projectName || "—"}\t${a.aliases || ""}`)
        .join("\n")
    );
  },

  async send(args) {
    const { rest, opts } = flags(args);
    const [agentId, inboxId, ...text] = rest;
    if (!agentId || !inboxId || !text.length) throw new Error("usage: pilo send <agentId> <inboxId> <요청>");
    const res = await call("POST", `/api/inbox/${inboxId}/tasks`, {
      toAgentId: Number(agentId),
      title: opts.title || text.join(" ").slice(0, 40),
      request: text.join(" ")
    });
    return out(`task #${res.id} → agent ${agentId}`);
  },

  async reply(args) {
    const [inboxId, ...text] = args;
    if (!inboxId || !text.length) throw new Error("usage: pilo reply <inboxId> <본문>");
    const res = await call("POST", `/api/inbox/${inboxId}/reply`, { body: text.join(" ") });
    return out(`final_reply #${res.id} 저장됨 (in-${inboxId})`);
  },

  async task([id]) {
    if (!id) throw new Error("usage: pilo task <id>");
    return out(await call("GET", `/api/tasks/${id}`));
  },

  async progress(args) {
    const [taskId, ...text] = args;
    if (!taskId || !text.length) throw new Error("usage: pilo progress <taskId> <한 줄>");
    const res = await call("POST", `/api/tasks/${taskId}/progress`, { text: text.join(" ") });
    return out(`task #${res.id} 진행: ${res.progress}`);
  },

  async done(args) {
    const { rest, opts } = flags(args);
    const [taskId, ...text] = rest;
    if (!taskId || !text.length) throw new Error("usage: pilo done <taskId> <보고>");
    const res = await call("POST", `/api/tasks/${taskId}/result`, {
      pmResult: text.join(" "),
      status: opts.status || "done",
      error: opts.error || "",
      tokensIn: Number(opts.in || 0),
      tokensOut: Number(opts.out || 0)
    });
    return out(`task #${res.id} ${res.status}`);
  },

  async block(args) {
    const { rest, opts } = flags(args);
    const [taskId, ...text] = rest;
    if (!taskId || !text.length) throw new Error("usage: pilo block <taskId> <질문>");
    const res = await call("POST", `/api/tasks/${taskId}/result`, {
      pmResult: opts.note || text.join(" "),
      question: text.join(" "),
      status: "blocked",
      tokensIn: Number(opts.in || 0),
      tokensOut: Number(opts.out || 0)
    });
    return out(`task #${res.id} ${res.status} — 사용자 결정 대기`);
  },

  async blocked() {
    const rows = await call("GET", "/api/blocked");
    if (!rows.length) return out("결정 대기 중인 작업 없음");
    return out(rows.map((r) => `#${r.id} ${r.agent} · ${r.project || "—"}\n   ${r.question}`).join("\n"));
  },

  async answer(args) {
    const [taskId, ...text] = args;
    if (!taskId || !text.length) throw new Error("usage: pilo answer <taskId> <답변>");
    const res = await call("POST", `/api/tasks/${taskId}/answer`, { body: text.join(" ") });
    return out(`task #${res.id} ${res.status} — agent 를 다시 깨웁니다`);
  },

  async api([method, path, body]) {
    if (!method || !path) throw new Error("usage: pilo api <METHOD> <path> [json]");
    return out(await call(method.toUpperCase(), path, body ? JSON.parse(body) : undefined));
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
