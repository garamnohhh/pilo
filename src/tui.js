import readline from "node:readline";
import { spawn } from "node:child_process";
import { readPort } from "./paths.js";
import { edit } from "./draft.js";

const port = Number(process.env.PILO_PORT || readPort());
const base = `http://127.0.0.1:${port}`;
const dashboardUrl = `${base}/dashboard`;
const launchCwd = process.env.PILO_LAUNCH_CWD || process.cwd();

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[38;2;62;212;156m",
  fg: "\x1b[38;2;217;222;217m",
  strong: "\x1b[38;2;238;242;238m",
  muted: "\x1b[38;2;111;122;115m",
  faint: "\x1b[38;2;79;90;83m",
  blue: "\x1b[38;2;150;178;214m",
  amber: "\x1b[38;2;218;184;88m",
  red: "\x1b[38;2;220;104;80m",
  line: "\x1b[38;2;28;33;31m"
};

const state = { input: "", cursor: 0, notes: [], busy: false, busySub: "" };

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
// Hangul and CJK take two terminal columns, so measure in columns, not characters.
const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
const cols = (s) => [...strip(s)].reduce((n, ch) => n + (wide.test(ch) ? 2 : 1), 0);
const pad = (s, n) => s + " ".repeat(Math.max(0, n - cols(s)));
function cut(s, n) {
  if (cols(s) <= n) return s;
  let out = "";
  let used = 0;
  for (const ch of strip(s)) {
    const w = wide.test(ch) ? 2 : 1;
    if (used + w > n - 1) break;
    out += ch;
    used += w;
  }
  return out + "…";
}
const line = (n) => c.line + "─".repeat(Math.max(1, n)) + c.reset;
const cell = (s, n) => pad(cut(s, n), n);
const pretty = (p) => String(p || "").replace(process.env.HOME || "", "~");
const tokens = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n || 0));

async function api(path, fallback) {
  try {
    const res = await fetch(base + path);
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

function wrap(text, width) {
  const out = [];
  for (const paragraph of String(text || "").split("\n")) {
    const words = paragraph.split(/(\s+)/).filter(Boolean);
    let cur = "";
    for (const word of words) {
      const next = cur + word;
      if (cols(next) > width) {
        if (cur) out.push(cur.trimEnd());
        cur = word.trimStart();
      } else {
        cur = next;
      }
    }
    out.push(cur.trimEnd());
  }
  return out.length ? out : [""];
}

function replyBlock(item, width) {
  const inner = Math.max(20, width - 4);
  const rows = [`${c.line}╭─${c.reset} ${c.green}FINAL_REPLY${c.reset} ${c.faint}in-${item.id}${c.reset}`];
  for (const part of wrap(item.finalReply, inner - 2)) rows.push(`${c.line}│${c.reset} ${c.fg}${part}${c.reset}`);
  rows.push(`${c.line}│${c.reset} ${c.faint}실행 로그 · 변경 파일 · 아티팩트는 :dash${c.reset}`);
  rows.push(`${c.line}╰${"─".repeat(inner)}${c.reset}`);
  return rows;
}

function waitingBlock(item, width) {
  const inner = Math.max(20, width - 4);
  const sub = item.routed ? `${item.routed} 작업 중 · pm_result 대기` : "요청 접수 · Pilo agent 확인 중";
  return [
    `${c.line}╭┈${c.reset} ${c.green}Pilo agent 정리 중…${c.reset} ${c.faint}in-${item.id}${c.reset}`,
    `${c.line}┊${c.reset} ${c.faint}${cut(sub, inner - 2)}${c.reset}`,
    `${c.line}╰${"┈".repeat(inner)}${c.reset}`
  ];
}

function setupScreen(setup, width) {
  const rows = [];
  rows.push(`${c.amber}●${c.reset} ${c.strong}setup required${c.reset}`);
  rows.push("");
  rows.push(`${c.muted}기동에 필요한 항목입니다. 명령은 ${c.fg}pilo up${c.muted} 하나뿐이고, agent 등록은 대시보드에서 합니다.${c.reset}`);
  rows.push("");
  if (setup.duplicatePilo) {
    rows.push(`${c.red}●${c.reset} ${c.strong}role=pilo agent가 ${setup.piloAgents.length}개 감지됨${c.reset}`);
    rows.push(`${c.faint}대표 agent는 정확히 하나여야 합니다. 대시보드에서 하나만 남기세요.${c.reset}`);
    for (const a of setup.piloAgents) rows.push(`  ${c.fg}${a.name}${c.reset} ${c.faint}${pretty(a.cwd)} · ${a.runtime || "runtime 미감지"}${c.reset}`);
    rows.push("");
  }
  const steps = [
    ["Docker runtime", setup.docker, "컨테이너 런타임 감지됨 (OrbStack 권장)", ""],
    ["herdr 실행 중", setup.herdr, `agent 세션 ${setup.sessions}개 감지됨`, "herdr를 먼저 띄워야 agent를 붙일 수 있습니다"],
    ["PostgreSQL 기동", setup.postgres, "pgvector 포함 · Docker Compose", "pilo up"],
    ["대표 agent 등록 (role=pilo)", setup.piloAgents.length === 1, "사용자와 대화할 agent 1개", "dashboard → Agents → register agent"],
    ["PM agent 등록 (선택)", setup.pmCount > 0, "PM이 없어도 Pilo agent와 대화는 가능합니다", "dashboard → Agents → register agent"]
  ];
  for (const [title, ok, desc, cmd] of steps) {
    const mark = ok ? `${c.green}✓${c.reset}` : `${c.faint}○${c.reset}`;
    rows.push(`${mark} ${ok ? c.muted : c.strong}${title}${c.reset}`);
    rows.push(`  ${c.faint}${cut(ok ? desc : cmd || desc, width - 4)}${c.reset}`);
  }
  rows.push("");
  rows.push(`${c.faint}:dash 로 대시보드를 열어 등록하세요.${c.reset}`);
  return rows;
}

function railRows(tree, width) {
  const rows = [`${c.faint}AGENT TREE${c.reset}`, ""];
  if (!tree.pilo) {
    rows.push(`${c.faint}대표 agent 없음${c.reset}`);
    return rows;
  }
  rows.push(`${c.green}●${c.reset} ${c.fg}${cut(tree.pilo.name, width - 12)}${c.reset} ${c.green}PILO${c.reset}`);
  rows.push(`  ${c.faint}사용자와 대화 · 취합${c.reset}`);
  rows.push("");
  if (!tree.pms.length) {
    rows.push(`${c.faint}Project agent 없음${c.reset}`);
    rows.push(`${c.faint}:dash 에서 PM 등록${c.reset}`);
    return rows;
  }
  for (const pm of tree.pms) {
    const color = pm.status === "failed" ? c.red : pm.status === "running" ? c.amber : c.green;
    rows.push(`${c.faint}└${c.reset} ${color}●${c.reset} ${c.fg}${cut(pm.name, width - 14)}${c.reset} ${c.blue}PM${c.reset}`);
    rows.push(`   ${c.faint}${cut(pm.projectName || "project 미지정", width - 5)}${c.reset}`);
    for (const w of pm.children) {
      rows.push(`   ${c.faint}└${c.reset} ${c.muted}${cut(w.name, width - 16)}${c.reset} ${c.faint}WORKER${c.reset}`);
    }
    rows.push("");
  }
  return rows;
}

async function render() {
  const width = process.stdout.columns || 120;
  const height = process.stdout.rows || 34;
  const marginX = width > 60 ? 2 : 0;
  const outWidth = Math.max(40, width - marginX * 2);
  const pre = " ".repeat(marginX);
  const railWidth = width >= 96 ? 30 : 0;
  const mainWidth = railWidth ? outWidth - railWidth - 3 : outWidth;

  const [setup, tree, inbox, overview, settings] = await Promise.all([
    api("/api/setup", { docker: true, herdr: false, sessions: 0, postgres: true, piloAgents: [], duplicatePilo: false, needsSetup: true, pmCount: 0 }),
    api("/api/agents/tree", { pilo: null, pms: [], orphanWorkers: [] }),
    api("/api/inbox", []),
    api("/api/overview", { stats: { pm: 0, worker: 0, failed: { total: 0 }, tokens: { total: 0 } } }),
    api("/api/settings", { tokens: { showInTui: true } })
  ]);

  process.stdout.write("\x1b[2J\x1b[H");
  console.log("");

  const agentLabel = tree.pilo ? `${c.green}●${c.reset} ${c.muted}${tree.pilo.name}${c.reset}` : `${c.faint}● 대표 agent 없음${c.reset}`;
  const topLeft = `${c.bold}${c.strong}pilo${c.reset} ${c.line}│${c.reset} ${agentLabel} ${c.faint}${pretty(launchCwd)}${c.reset}`;
  const topRight = `${c.faint}:help — commands${c.reset}`;
  console.log(pre + cell(topLeft, outWidth - cols(topRight)) + topRight);
  console.log(pre + line(outWidth));

  const running = tree.pms.filter((p) => p.status === "running").length;
  const statusLeft = `${c.green}●${c.reset} ${c.muted}herdr${c.reset} ${c.faint}${setup.herdr ? `connected · ${setup.sessions} sessions` : "not detected"}${c.reset}`;
  const statusMid = `${c.muted}pm${c.reset} ${c.fg}${overview.stats.pm}${c.reset} · ${c.muted}worker${c.reset} ${c.fg}${overview.stats.worker}${c.reset} · ${c.muted}running${c.reset} ${c.green}${running}${c.reset} · ${c.muted}failed${c.reset} ${c.red}${overview.stats.failed.total}${c.reset}`;
  const showTokens = settings.tokens?.showInTui !== false;
  const statusRight = showTokens ? `${c.muted}tokens${c.reset} ${c.fg}${tokens(overview.stats.tokens.total)}${c.reset} ${c.faint}today${c.reset}` : "";
  const gap = Math.max(2, outWidth - cols(statusLeft) - cols(statusMid) - cols(statusRight) - 3);
  console.log(pre + cut(`${statusLeft}   ${statusMid}${" ".repeat(gap)}${statusRight}`, outWidth));
  console.log(pre + line(outWidth));

  const visible = Math.max(8, height - 11);
  let rows = [];

  if (setup.needsSetup) {
    rows = setupScreen(setup, outWidth).map((r) => "  " + r);
  } else {
    const feed = [];
    for (const item of [...inbox].reverse().slice(-6)) {
      feed.push(...wrap(item.userRequest, mainWidth - 6).map((x, i) => `  ${i ? " " : c.green + "❯" + c.reset} ${c.fg}${x}${c.reset}`));
      feed.push("");
      feed.push(...(item.finalReply ? replyBlock(item, mainWidth - 4) : waitingBlock(item, mainWidth - 4)).map((r) => "  " + r));
      feed.push("");
    }
    for (const note of state.notes.slice(-3)) {
      feed.push(...wrap(note, mainWidth - 8).map((x) => `  ${c.faint}pilo${c.reset} ${c.muted}${x}${c.reset}`));
      feed.push("");
    }
    if (!feed.length) {
      feed.push(`  ${c.faint}아래 프롬프트에 지시를 입력하세요. Pilo agent가 정리해서 final_reply로 답합니다.${c.reset}`);
    }
    rows = feed;
  }

  const rail = railWidth ? railRows(tree, railWidth - 3) : [];
  const shown = rows.slice(-visible);
  for (let i = 0; i < visible; i++) {
    const left = pad(cut(shown[i] || "", mainWidth), mainWidth);
    if (!railWidth) console.log(pre + left);
    else console.log(pre + `${left} ${c.line}│${c.reset} ${cut(rail[i] || "", railWidth - 3)}`);
  }

  console.log(pre + line(outWidth));
  console.log(pre + `${c.faint}↵ send   ⇧↵ 줄바꿈   ←→ 커서   :dash dashboard   :agents tree   :inbox 미처리   :cost tokens   :q quit${c.reset}`);
  const inputLines = state.input.split("\n");
  for (let i = 0; i < inputLines.length - 1; i++) {
    console.log(pre + `${c.faint}│${c.reset} ${inputLines[i]}`);
  }
  process.stdout.write(pre + `${c.green}❯${c.reset} ${inputLines[inputLines.length - 1]}\x1b[?25h`);

  // Put the terminal cursor where the edit cursor is: count rows up from the last
  // line, then step in by the column width of the text before the cursor.
  const before = state.input.slice(0, state.cursor).split("\n");
  const rowsUp = inputLines.length - before.length;
  const column = marginX + 2 + cols(before[before.length - 1]);
  if (rowsUp > 0) process.stdout.write(`\x1b[${rowsUp}A`);
  process.stdout.write(`\r\x1b[${column}C`);
}

function note(text) {
  state.notes.push(text);
}

async function command(raw) {
  const [word, ...rest] = raw.slice(1).trim().toLowerCase().split(/\s+/);
  if (word === "q" || word === "quit") return close();
  if (word === "dash" || word === "dashboard") {
    spawn("open", [dashboardUrl + (rest[0] ? `#${rest[0]}` : "")], { detached: true, stdio: "ignore" }).unref();
    return note("대시보드를 열었습니다.");
  }
  if (word === "agents") {
    const tree = await api("/api/agents/tree", { pilo: null, pms: [] });
    if (!tree.pilo) return note("등록된 agent가 없습니다. :dash agents 에서 등록하세요.");
    const parts = [`${tree.pilo.name} ●`];
    for (const pm of tree.pms) parts.push(`${pm.name} ${pm.status} (${pm.children.map((w) => w.name).join(", ") || "worker 없음"})`);
    return note(parts.join(" │ "));
  }
  if (word === "inbox") {
    const inbox = await api("/api/inbox", []);
    const pending = inbox.filter((i) => i.status !== "replied");
    return note(pending.length ? pending.map((i) => `in-${i.id} ${i.status}`).join(" · ") : "미처리 요청 없음");
  }
  if (word === "cost") {
    const o = await api("/api/overview", { stats: { tokens: { in: 0, out: 0, total: 0 } } });
    const t = o.stats.tokens;
    return note(`tokens ${tokens(t.total)} · in ${tokens(t.in)} · out ${tokens(t.out)} (today)`);
  }
  if (word === "help") {
    return note(":dash 대시보드   :agents agent tree   :inbox 미처리 요청   :cost 토큰 사용량   :q 종료");
  }
  return note(`unknown command: :${word} — :help 참고`);
}

async function send(text) {
  if (text.startsWith(":")) return command(text.replace(/\n/g, " "));
  const res = await fetch(`${base}/api/inbox`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userRequest: text, cwd: launchCwd })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return note(`요청 저장 실패: ${err.error || res.status}`);
  }
}

function close() {
  process.stdout.write("\x1b[<u");
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\x1b[2J\x1b[H");
  process.exit(0);
}

// ponytail: no TTY means someone is smoke-testing the render, so draw one frame and stop.
if (!process.stdin.isTTY) {
  await render();
  console.log("");
  process.exit(0);
}

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
// Ask for the kitty keyboard protocol so the terminal can tell Shift+Enter apart
// from Enter. Terminals without it ignore the request and Ctrl+J still works.
process.stdout.write("\x1b[>1u");

process.stdin.on("keypress", async (ch, key) => {
  if (key.ctrl && key.name === "c") close();
  const next = edit({ input: state.input, cursor: state.cursor }, ch, key);
  if (next.action === "send") {
    const text = state.input.replace(/\s+$/, "");
    state.input = "";
    state.cursor = 0;
    if (text.trim()) await send(text);
  } else {
    state.input = next.input;
    state.cursor = next.cursor;
  }
  await render();
});

process.stdout.on("resize", render);
setInterval(render, 4000).unref();
await render();
