import readline from "node:readline";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { readPort } from "./paths.js";
import { edit } from "./draft.js";
import { parseMouse, ENABLE as MOUSE_ON, DISABLE as MOUSE_OFF } from "./mouse.js";

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

const state = {
  input: "",
  cursor: 0,
  notes: [],
  pasting: false,
  filter: null,
  spin: 0,
  folded: new Set(),
  unfolded: new Set(),
  hits: new Map(),
  rowCount: 0,
  pad: 0,
  scroll: 0,
  maxScroll: 0,
  data: null
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

function railRows(tree, width, actions = []) {
  const rows = [`${c.faint}AGENT TREE${c.reset}`, ""];
  actions.push(null, null);
  if (!tree.pilo) {
    rows.push(`${c.faint}대표 agent 없음${c.reset}`);
    actions.push(null);
    return rows;
  }

  // The name gets a line to itself; role, project and workload go on the next one.
  // Cramming them onto one row is what turned every name into an ellipsis.
  const entry = (indent, icon, name, meta, tag, tagColor, action = null) => {
    rows.push(`${indent}${icon.color}${icon.icon}${c.reset} ${c.fg}${cut(name, width - indent.length - 2)}${c.reset}`);
    actions.push(action);
    rows.push(`${indent}  ${tagColor}${tag}${c.reset} ${c.faint}${cut(meta, width - indent.length - tag.length - 3)}${c.reset}`);
    actions.push(action);
  };

  // clicking the desk agent clears the project filter
  entry("", statusIcon(tree.pilo.status, state.spin), tree.pilo.name, "전체 보기", "PILO", c.green, {
    type: "project",
    name: null
  });
  rows.push("");
  actions.push(null);

  if (!tree.pms.length) {
    rows.push(`${c.faint}Project agent 없음${c.reset}`);
    rows.push(`${c.faint}:dash 에서 PM 등록${c.reset}`);
    actions.push(null, null);
    return rows;
  }

  for (const pm of tree.pms) {
    const load =
      pm.status === "running" ? `작업 ${pm.openTasks}건` : pm.status === "unbound" ? "세션 미연결" : pm.status;
    // most PMs are named after their project; repeating it just eats the line
    const project = pm.projectName && pm.projectName !== pm.name ? `${pm.projectName} · ` : "";
    const filter = { type: "project", name: pm.projectName || pm.name };
    const active = state.filter && state.filter === filter.name ? `${c.green}◂${c.reset} ` : "";
    entry("", statusIcon(pm.status, state.spin), `${active}${pm.name}`, `${project}${load}`, "PM", c.blue, filter);
    for (const w of pm.children) {
      entry("  ", statusIcon(w.status, state.spin), w.name, w.specialty || w.status, "WORKER", c.muted, filter);
    }
    rows.push("");
    actions.push(null);
  }
  return rows;
}

async function refresh() {
  const [setup, tree, inbox, overview, settings] = await Promise.all([
    api("/api/setup", { docker: true, herdr: false, sessions: 0, postgres: true, piloAgents: [], duplicatePilo: false, needsSetup: true, pmCount: 0 }),
    api("/api/agents/tree", { pilo: null, pms: [], orphanWorkers: [] }),
    api("/api/inbox", []),
    api("/api/overview", { stats: { pm: 0, worker: 0, failed: { total: 0 }, tokens: { total: 0 } } }),
    api("/api/settings", { tokens: { showInTui: true } })
  ]);
  state.data = { setup, tree, inbox, overview, settings };
  return state.data;
}

function applyProject(name) {
  state.filter = name || null;
  state.scroll = 0;
  note(name ? `필터: ${name}` : "필터 해제 — 전체 요청 표시");
  render();
}

function handleClick({ x, y }) {
  const hit = state.hits.get(y);
  if (!hit) return;
  const width = process.stdout.columns || 120;
  const marginX = width > 60 ? 2 : 0;
  const railWidth = width >= 96 ? Math.min(40, Math.max(30, Math.round(width * 0.28))) : 0;
  const mainWidth = railWidth ? width - marginX * 2 - railWidth - 3 : width - marginX * 2;
  const action = x > marginX + mainWidth + 1 ? hit.rail : hit.main;
  if (!action) return;
  if (action.type === "project") return applyProject(action.name);
  if (action.type === "fold") {
    // The view is anchored to the bottom, so opening an answer would push the
    // clicked line upward. Shift the scroll by exactly what was added below it.
    const before = state.rowCount;
    toggleFold(action.id, action.fromNewest);
    render();
    const grew = state.rowCount - before;
    if (grew < 0) {
      state.pad += -grew;
    } else if (grew > 0) {
      const fromPad = Math.min(state.pad, grew);
      state.pad -= fromPad;
      state.scroll = Math.max(0, Math.min(state.maxScroll, state.scroll + grew - fromPad));
    }
    if (grew) render();
  }
}

// Older requests are folded by default; only the newest two open on their own.
const OPEN_BY_DEFAULT = 2;

function isFolded(id, fromNewest) {
  const key = String(id);
  if (state.unfolded.has(key)) return false;
  if (state.folded.has(key)) return true;
  return fromNewest >= OPEN_BY_DEFAULT;
}

function toggleFold(id, fromNewest) {
  const key = String(id);
  if (isFolded(key, fromNewest)) {
    state.unfolded.add(key);
    state.folded.delete(key);
  } else {
    state.folded.add(key);
    state.unfolded.delete(key);
  }
}

function scrollBy(rows) {
  if (rows < 0 && state.scroll === 0) state.pad = Math.max(0, state.pad + rows);
  const next = Math.max(0, Math.min(state.maxScroll, state.scroll + rows));
  if (next === state.scroll) return;
  state.scroll = next;
  render();
}

// The terminal wraps a long draft line on its own, which threw off the cursor row
// and made an edit look like it hit a different line. Wrap it here instead, and
// compute the cursor from the same layout that gets drawn.
function layoutDraft(input, width) {
  const rows = [];
  let index = 0;
  for (const line of input.split("\n")) {
    let start = 0;
    let used = 0;
    let chunk = "";
    for (const ch of line) {
      const w = wide.test(ch) ? 2 : 1;
      if (used + w > width) {
        rows.push({ text: chunk, start: index + start });
        start += chunk.length;
        chunk = "";
        used = 0;
      }
      chunk += ch;
      used += w;
    }
    rows.push({ text: chunk, start: index + start });
    index += line.length + 1;
  }
  return rows;
}

function statusIcon(status, spin) {
  if (status === "running") return { icon: SPINNER[spin % SPINNER.length], color: c.amber };
  if (status === "failed") return { icon: "✕", color: c.red };
  if (status === "unbound") return { icon: "○", color: c.faint };
  if (status === "queued") return { icon: "◍", color: c.faint };
  if (status === "archived") return { icon: "·", color: c.faint };
  return { icon: "●", color: c.green };
}

function render() {
  const width = process.stdout.columns || 120;
  const height = process.stdout.rows || 34;
  const marginX = width > 60 ? 2 : 0;
  const outWidth = Math.max(40, width - marginX * 2);
  const pre = " ".repeat(marginX);
  const railWidth = width >= 96 ? Math.min(40, Math.max(30, Math.round(width * 0.28))) : 0;
  const mainWidth = railWidth ? outWidth - railWidth - 3 : outWidth;

  if (!state.data) return;
  const { setup, tree, inbox, overview, settings } = state.data;
  const screen = [""];
  const emit = (text) => screen.push(text);

  const agentLabel = tree.pilo ? `${c.green}●${c.reset} ${c.muted}${tree.pilo.name}${c.reset}` : `${c.faint}● 대표 agent 없음${c.reset}`;
  const topLeft = `${c.bold}${c.strong}pilo${c.reset} ${c.line}│${c.reset} ${agentLabel} ${c.faint}${pretty(launchCwd)}${c.reset}`;
  const topRight = `${c.faint}:help — commands${c.reset}`;
  emit(pre + cell(topLeft, outWidth - cols(topRight)) + topRight);
  emit(pre + line(outWidth));

  const running = tree.pms.filter((p) => p.status === "running").length;
  const statusLeft = `${c.green}●${c.reset} ${c.muted}herdr${c.reset} ${c.faint}${setup.herdr ? `connected · ${setup.sessions} sessions` : "not detected"}${c.reset}`;
  const statusMid = `${c.muted}pm${c.reset} ${c.fg}${overview.stats.pm}${c.reset} · ${c.muted}worker${c.reset} ${c.fg}${overview.stats.worker}${c.reset} · ${c.muted}running${c.reset} ${c.green}${running}${c.reset} · ${c.muted}failed${c.reset} ${c.red}${overview.stats.failed.total}${c.reset}`;
  const showTokens = settings.tokens?.showInTui !== false;
  const statusRight = showTokens ? `${c.muted}tokens${c.reset} ${c.fg}${tokens(overview.stats.tokens.total)}${c.reset} ${c.faint}today${c.reset}` : "";
  const gap = Math.max(2, outWidth - cols(statusLeft) - cols(statusMid) - cols(statusRight) - 3);
  emit(pre + cut(`${statusLeft}   ${statusMid}${" ".repeat(gap)}${statusRight}`, outWidth));
  emit(pre + line(outWidth));

  const visible = Math.max(8, height - 11);
  let rows = [];
  let rowActions = [];

  if (setup.needsSetup) {
    rows = setupScreen(setup, outWidth).map((r) => "  " + r);
  } else {
    const feed = [];
    const actions = [];
    const visibleInbox = state.filter
      ? inbox.filter((i) => (i.project || "").split(", ").includes(state.filter))
      : inbox;
    if (state.filter) {
      feed.push(`  ${c.faint}필터: ${c.fg}${state.filter}${c.faint} · PILO 클릭 또는 :project all 로 해제${c.reset}`);
      actions.push({ type: "project", name: null });
      feed.push("");
      actions.push(null);
    }
    const ordered = visibleInbox.slice().reverse();
    ordered.forEach((item, index) => {
      const fromNewest = ordered.length - 1 - index;
      const fold = { type: "fold", id: String(item.id), fromNewest };
      const folded = isFolded(item.id, fromNewest);
      // folding hides the answer; the question keeps its green prompt mark and,
      // when folded, its first two lines
      const lines = wrap(item.userRequest, mainWidth - 6);
      const shownLines = folded ? lines.slice(0, 2) : lines;
      const question = shownLines.map((x, i) => `  ${i ? " " : c.green + "❯" + c.reset} ${c.fg}${x}${c.reset}`);
      if (folded && lines.length > shownLines.length) {
        question[question.length - 1] += `${c.faint} …${c.reset}`;
      }
      feed.push(...question);
      actions.push(...question.map(() => fold));
      if (item.project) {
        feed.push(`    ${c.faint}${item.project}${folded ? ` · ${item.finalReply ? "완료" : "대기"}` : ""}${c.reset}`);
        actions.push(fold);
      }
      feed.push("");
      actions.push(null);
      if (!folded) {
        const block = (item.finalReply ? replyBlock(item, mainWidth - 4) : waitingBlock(item, mainWidth - 4)).map((r) => "  " + r);
        feed.push(...block);
        // only the header line folds, so clicking inside an answer does nothing
        actions.push(...block.map((_row, i) => (i === 0 ? fold : null)));
        feed.push("");
        actions.push(null);
      }
    });
    for (const note of state.notes.slice(-3)) {
      const lines = wrap(note, mainWidth - 8).map((x) => `  ${c.faint}pilo${c.reset} ${c.muted}${x}${c.reset}`);
      feed.push(...lines, "");
      actions.push(...lines.map(() => null), null);
    }
    if (feed.length <= (state.filter ? 2 : 0)) {
      feed.push(`  ${c.faint}${state.filter ? state.filter + " 프로젝트 요청 없음" : "아래 프롬프트에 지시를 입력하세요."} ${c.reset}`);
    }
    rows = feed;
    rowActions = actions;
  }

  const railActions = [];
  const rail = railWidth ? railRows(tree, railWidth - 3, railActions) : [];

  // scroll counts rows up from the bottom; 0 keeps the newest line in view.
  // pad is blank space kept below the feed so folding does not shove the line
  // the user clicked away from where they clicked it.
  const total = rows.length + state.pad;
  state.maxScroll = Math.max(0, total - visible);
  state.scroll = Math.min(state.scroll, state.maxScroll);
  const bottom = total - state.scroll;
  const shown = rows.slice(Math.max(0, bottom - visible), bottom);
  if (state.scroll > 0) {
    shown[0] = `  ${c.amber}↑${c.reset} ${c.faint}위로 ${state.scroll}줄 · PgDn/⇧↓ 로 최근으로${c.reset}`;
  } else if (state.maxScroll > 0) {
    shown[0] = `  ${c.faint}↑ 이전 기록 ${state.maxScroll}줄 · PgUp/⇧↑${c.reset}`;
  }
  state.rowCount = rows.length;
  const first = Math.max(0, bottom - visible);
  state.hits = new Map();
  for (let i = 0; i < visible; i++) {
    const left = pad(cut(shown[i] || "", mainWidth), mainWidth);
    if (!railWidth) emit(pre + left);
    else emit(pre + `${left} ${c.line}│${c.reset} ${cut(rail[i] || "", railWidth - 3)}`);
    // screen[0] is a blank line, so the terminal row is index + 1
    state.hits.set(screen.length, { main: rowActions[first + i] || null, rail: railActions[i] || null });
  }

  emit(pre + line(outWidth));
  emit(pre + `${c.faint}↵ send   ⇧↵ 줄바꿈   ←→ 커서   휠 스크롤   클릭: 요청 접기 · agent 필터   :help${c.reset}`);
  const draft = layoutDraft(state.input, outWidth - 2);
  let cursorRow = screen.length + 1;
  let cursorCol = marginX + 3;
  draft.forEach((row, i) => {
    emit(pre + `${i === 0 ? c.green + "❯" + c.reset : " "} ${row.text}`);
    const end = row.start + row.text.length;
    if (state.cursor >= row.start && (state.cursor <= end || i === draft.length - 1)) {
      cursorRow = screen.length;
      cursorCol = marginX + 3 + cols(row.text.slice(0, Math.max(0, state.cursor - row.start)));
    }
  });

  // One write per frame: home, each row cleared to end of line, then clear the
  // rest. Clearing the whole screen first is what made the display blink.
  process.stdout.write(
    "\x1b[H" + screen.map((row) => row + "\x1b[K").join("\n") + "\x1b[J" +
    `\x1b[${cursorRow};${cursorCol}H\x1b[?25h`
  );
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
  if (word === "project" || word === "p") {
    const wanted = rest.join(" ").trim();
    const projects = [...new Set((state.data?.inbox || []).flatMap((i) => (i.project || "").split(", ").filter(Boolean)))];
    if (!wanted) {
      return note(`프로젝트: ${projects.join(" · ") || "없음"}   현재 필터: ${state.filter || "전체"}   (:project <이름> / :project all)`);
    }
    if (wanted === "all" || wanted === "전체") {
      applyProject(null);
      return;
    }
    const hit = projects.find((p) => p.toLowerCase() === wanted.toLowerCase());
    if (!hit) return note(`그런 프로젝트가 없다: ${wanted} (${projects.join(", ") || "등록된 프로젝트 없음"})`);
    applyProject(hit);
    return;
  }
  if (word === "fold" || word === "unfold") {
    const target = rest.join("").replace(/^in-/, "");
    const ids = (state.data?.inbox || []).map((i) => String(i.id));
    if (target === "default") {
      state.folded.clear();
      state.unfolded.clear();
      return note(`기본값 복귀 — 최신 ${OPEN_BY_DEFAULT}건만 펼침`);
    }
    if (target && target !== "all") {
      if (!ids.includes(target)) return note(`in-${target} 를 찾을 수 없다`);
      if (word === "fold") {
        state.folded.add(target);
        state.unfolded.delete(target);
      } else {
        state.unfolded.add(target);
        state.folded.delete(target);
      }
      return note(`in-${target} ${word === "fold" ? "접음" : "폄"}`);
    }
    if (word === "fold") {
      state.unfolded.clear();
      ids.forEach((id) => state.folded.add(id));
    } else {
      state.folded.clear();
      ids.forEach((id) => state.unfolded.add(id));
    }
    return note(word === "fold" ? `전체 접음 (${ids.length}건)` : `전체 폄 (${ids.length}건)`);
  }
  if (word === "help") {
    return note(":dash 대시보드   :agents tree   :inbox 미처리   :project <이름>|all 필터   :fold [id|all|default]   :unfold   :cost   :q");
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

function restoreTerminal() {
  process.stdout.write(MOUSE_OFF + "\x1b[?2004l\x1b[<u\x1b[?1049l\x1b[23;0t");
}

function close() {
  restoreTerminal();
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.exit(0);
}

// ponytail: no TTY means someone is smoke-testing the render, so draw one frame and stop.
if (!process.stdin.isTTY) {
  await refresh();
  render();
  console.log("");
  process.exit(0);
}

// Keys go through a filtered stream so mouse reports never reach readline.
const keys = new PassThrough();
readline.emitKeypressEvents(keys);
process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  const { wheel, clicks, rest } = parseMouse(chunk);
  if (wheel) scrollBy(wheel * 3);
  for (const click of clicks) handleClick(click);
  if (rest.length) keys.write(rest);
});
// Ask for the kitty keyboard protocol so the terminal can tell Shift+Enter apart
// from Enter. Terminals without it ignore the request and Ctrl+J still works.
// Push the current title so it can be restored, then name the tab.
process.stdout.write("\x1b[22;0t\x1b]0;pilo\x07\x1b[?1049h\x1b[>1u\x1b[?2004h" + MOUSE_ON);

// A crash must not leave the user staring at an empty alternate screen.
process.on("exit", restoreTerminal);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => close());
process.on("uncaughtException", (err) => {
  restoreTerminal();
  console.error(err.stack || err.message);
  process.exit(1);
});

keys.on("keypress", async (ch, key) => {
  if (key.ctrl && key.name === "c") close();

  const page = Math.max(3, (process.stdout.rows || 34) - 14);
  if (key.name === "pageup" || (key.shift && key.name === "up")) return scrollBy(page);
  if (key.name === "pagedown" || (key.shift && key.name === "down")) return scrollBy(-page);

  const next = edit({ input: state.input, cursor: state.cursor }, ch, key, { pasting: state.pasting });
  if (next.action === "paste-start" || next.action === "paste-end") {
    state.pasting = next.action === "paste-start";
    render();
    return;
  }
  if (next.action === "send") {
    const text = state.input.replace(/\s+$/, "");
    state.input = "";
    state.cursor = 0;
    state.scroll = 0;
    state.pad = 0;
    if (text.trim()) {
      await send(text);
      await refresh();
    }
  } else {
    if (next.input !== state.input) state.scroll = 0;
    state.input = next.input;
    state.cursor = next.cursor;
  }
  render();
});

process.stdout.on("resize", render);

// Data on a timer, frames on demand. Typing no longer waits on five HTTP calls.
setInterval(async () => {
  await refresh();
  render();
}, 2500).unref();

// The spinner only ticks while something is actually running.
setInterval(() => {
  const tree = state.data?.tree;
  const busy =
    tree &&
    [tree.pilo, ...(tree.pms || []), ...(tree.pms || []).flatMap((p) => p.children || [])].some(
      (a) => a && a.status === "running"
    );
  if (!busy) return;
  state.spin += 1;
  render();
}, 120).unref();

await refresh();
render();
