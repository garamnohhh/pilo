import readline from "node:readline";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readPort } from "./paths.js";
import { edit, layoutDraft } from "./draft.js";
import { charWidth, cols, setAmbiguousWidth } from "./width.js";
import { parseCommand, suggest, HELP } from "./commands.js";
import { alignTables } from "./markdown.js";
import { parseMouse, ENABLE as MOUSE_ON, DISABLE as MOUSE_OFF } from "./mouse.js";

const port = Number(process.env.PILO_PORT || readPort());
const base = `http://127.0.0.1:${port}`;
const dashboardUrl = `${base}/dashboard`;
const launchCwd = process.env.PILO_LAUNCH_CWD || process.cwd();

// Colour comes in three grades. Truecolor gets the palette as designed; a
// 256-colour terminal gets the nearest cube entry; NO_COLOR (or a terminal that
// says nothing at all) gets shape only — the layout never depends on colour.
const NO_COLOR = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "";
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || "");
const TERM = process.env.TERM || "";
const COLOR = NO_COLOR || TERM === "dumb" || !TERM ? "none" : TRUECOLOR ? "true" : "256";

// The 6x6x6 cube plus the grey ramp, which is what 256-colour terminals have.
function cube(r, g, b) {
  const grey = Math.abs(r - g) < 12 && Math.abs(g - b) < 12;
  if (grey) {
    const level = Math.round(((r + g + b) / 3 - 8) / 10);
    if (level <= 0) return 16;
    if (level >= 23) return 231;
    return 232 + level;
  }
  const step = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.round((v - 35) / 40));
  return 16 + 36 * step(r) + 6 * step(g) + step(b);
}

const fg = (r, g, b) =>
  COLOR === "none" ? "" : COLOR === "true" ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${cube(r, g, b)}m`;
const bg = (r, g, b) =>
  COLOR === "none" ? "" : COLOR === "true" ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${cube(r, g, b)}m`;

const c = {
  reset: COLOR === "none" ? "" : "\x1b[0m",
  bold: COLOR === "none" ? "" : "\x1b[1m",
  green: fg(62, 212, 156),
  fg: fg(217, 222, 217),
  strong: fg(238, 242, 238),
  muted: fg(111, 122, 115),
  faint: fg(79, 90, 83),
  blue: fg(150, 178, 214),
  amber: fg(218, 184, 88),
  red: fg(220, 104, 80),
  amberBright: fg(224, 183, 85),
  redSoft: fg(224, 122, 107),
  // panel frames and the tree's own hierarchy lines are two different greys
  line: fg(30, 36, 34),
  branch: fg(62, 71, 68),
  rule: fg(23, 27, 25),
  hair: fg(20, 24, 23)
};

// Role labels are filled blocks, not bracketed text. Without colour the brackets
// come back, because a bare word in a rule of dashes reads as noise.
// The 6x6x6 cube collapses these dark tints onto the same entry, so the
// 256-colour badges pick their own indices rather than being derived.
const pick = (code, x256) => (COLOR === "none" ? "" : COLOR === "true" ? code : x256);
const BADGE = {
  PILO: { bg: pick(bg(43, 74, 60), "\x1b[48;5;22m"), fg: pick(fg(214, 245, 230), "\x1b[38;5;194m") },
  PM: { bg: pick(bg(38, 52, 61), "\x1b[48;5;24m"), fg: pick(fg(211, 230, 242), "\x1b[38;5;189m") },
  WORKER: { bg: pick(bg(38, 45, 42), "\x1b[48;5;236m"), fg: pick(fg(185, 195, 188), "\x1b[38;5;250m") },
  FINAL_REPLY: { bg: pick(bg(43, 74, 60), "\x1b[48;5;22m"), fg: pick(fg(214, 245, 230), "\x1b[38;5;194m") }
};

// Small caps make the badge read a size smaller without a second font. Terminals
// without those glyphs fall back to capitals, and --ascii keeps the brackets.
const ASCII = process.argv.includes("--ascii");
const SMALL = { A: "ᴀ", B: "ʙ", C: "ᴄ", D: "ᴅ", E: "ᴇ", F: "ꜰ", G: "ɢ", H: "ʜ", I: "ɪ", J: "ᴊ", K: "ᴋ",
  L: "ʟ", M: "ᴍ", N: "ɴ", O: "ᴏ", P: "ᴘ", Q: "ǫ", R: "ʀ", S: "s", T: "ᴛ", U: "ᴜ", V: "ᴠ", W: "ᴡ",
  X: "x", Y: "ʏ", Z: "ᴢ", _: " " };
// Project names arrive lowercase and carry digits and hyphens; only the letters
// have small-cap glyphs, and everything else is left exactly as it is.
const smallCaps = (tag) => [...String(tag).toUpperCase()].map((ch) => SMALL[ch] || ch).join("");

// No padding inside the badge: the fill hugs the letters, and the two spaces
// before it do the separating.
const badgeText = (tag) => (ASCII || COLOR === "none" ? `[${tag}]` : smallCaps(tag));
function badge(tag) {
  const paint = BADGE[tag] || BADGE.WORKER;
  return ASCII || COLOR === "none" ? `[${tag}]` : `${paint.bg}${paint.fg}${badgeText(tag)}${c.reset}`;
}

// Card surfaces: a tint painted to the card's full width, and the accent bar that
// stands in for a left border.
const CARD = {
  reply: { tint: bg(15, 19, 18) },
  waiting: { tint: bg(12, 16, 14) }
};
const BAR = "▌";
// One colour per state, worn by the question's mark and by the card's accent bar
// so the two read as the same thing.
const STATE_COLOUR = { done: fg(62, 212, 156), working: fg(218, 184, 88), attention: fg(220, 104, 80) };
// Work in flight pulses between that colour and a dimmer one; a finished or
// stuck request holds still, because a blink is a claim that something is
// happening right now.
const PULSE_DIM = fg(120, 100, 46);
const pulseColour = (which) =>
  which === "working" && !state.pulse ? PULSE_DIM : STATE_COLOUR[which] || STATE_COLOUR.done;

const state = {
  input: "",
  cursor: 0,
  notes: [],
  mouse: true,
  pasting: false,
  pasteBuffer: "",
  pastes: new Map(),
  filter: null,
  spin: 0,
  pulse: true,
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
const pad = (s, n) => s + " ".repeat(Math.max(0, n - cols(s)));
function cut(s, n) {
  if (cols(s) <= n) return s;
  let out = "";
  let used = 0;
  // the ellipsis is itself ambiguous, so reserve whatever it will really cost
  const tail = charWidth("…");
  for (const ch of strip(s)) {
    const w = charWidth(ch);
    if (used + w > n - tail) break;
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

function elapsed(from, to) {
  if (!from || !to) return "";
  const ms = new Date(to) - new Date(from);
  if (ms < 0) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return min < 60 ? `${min}m ${sec % 60}s` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

// One card shape for both states, so a request that is still running looks like
// the same thing it will become. The card is a painted surface: an accent bar
// down the left edge, a tint carried to the card's full width — padding included,
// or the background would stop where the text does — and a blank tinted row above
// and below for breathing room.
function cardBlock({ box, title, titleColor, right, body, footer, surface, state = "done" }) {
  const paint = { ...(CARD[surface] || CARD.reply), accent: STATE_COLOUR[state] || STATE_COLOUR.done };
  // The accent bar owns the first column and the tint carries to the card's full
  // width; two spaces of padding on each side keep the text off both edges.
  const text = Math.max(8, box - 5);
  // A reset inside the content — a badge ends with one — would drop the tint for
  // the rest of the row, so every reset re-asserts it.
  const keep = (t) => (paint.tint ? String(t).split(c.reset).join(c.reset + paint.tint) : String(t));
  const line = (content, colour = c.fg) =>
    `${paint.accent}${BAR}${c.reset}${paint.tint}  ${colour}${keep(pad(cut(content, text), text))}${c.reset}${paint.tint}  ${c.reset}`;

  const gap = Math.max(1, text - cols(title) - cols(right));
  const header =
    `${paint.accent}${BAR}${c.reset}${paint.tint}  ${titleColor}${keep(title)}${c.reset}${paint.tint}` +
    `${" ".repeat(gap)}${c.faint}${right}${c.reset}${paint.tint}  ${c.reset}`;

  // A blank tinted row top and bottom is the card's own margin.
  const rows = [line(""), header, line("")];
  for (const part of body) rows.push(line(part));
  if (footer) rows.push(line(footer, c.faint));
  rows.push(line(""));
  return rows;
}

function replyBlock(item, width, tagged) {
  const box = Math.max(24, width - 2);
  const took = elapsed(item.createdAt, item.repliedAt);
  // The question above already names who answered. The header repeats it only
  // when it would say something different — several agents on one request, where
  // the badge collapses the list and the header can spell it out.
  const who = item.routed || "";
  const extra = who && who !== (tagged?.plain || "") ? ` ${c.green}${who}${c.reset}` : "";
  return cardBlock({
    box,
    title: `${badge("FINAL_REPLY")}${extra}`,
    titleColor: "",
    right: took ? `in-${item.id} · ${took}` : `in-${item.id}`,
    body: wrap(alignTables(item.finalReply, box - 5), box - 5),
    footer: "실행 로그 · 변경 파일 · 아티팩트는 :dash",
    surface: "reply",
    state: "done"
  });
}

function waitingBlock(item, width) {
  const box = Math.max(24, width - 2);
  // Work finished and nobody wrote the answer. That is not progress, so it gets
  // its own card instead of a spinner that would never stop.
  if (item.needsReply) {
    const many = Number(item.taskCount || 0) > 1;
    return cardBlock({
      box,
      title: "답변 저장 필요",
      titleColor: c.red,
      right: `in-${item.id}`,
      body: [
        many
          ? `${item.routed || "agent"} 결과 ${item.taskCount}건 도착 · 취합해서 저장해야 함`
          : `${item.routed || "agent"} 결과 도착 · 최종 답변 미저장`
      ],
      footer: `pilo inbox ${item.id} 로 결과 확인 · pilo reply ${item.id} "답변" · 자세히는 :dash`,
      surface: "reply",
      state: "attention"
    });
  }
  // Work in flight: one line — what the agent last said about it, and who is
  // holding it, pushed to the right edge. The bar itself does the pulsing now,
  // so the line starts at the same column as any other card's text.
  const paint = { ...CARD.waiting, accent: pulseColour("working") };
  const text = Math.max(8, box - 5);
  const said = item.progress || (item.routed ? "작업 중 · pm_result 대기" : "요청 접수 · Pilo agent 확인 중");
  const who = item.routed || "";
  const room = text - cols(who) - 1;
  const words = cut(said, Math.max(6, room));
  const gap = Math.max(1, text - cols(words) - cols(who));
  const blank = `${paint.accent}${BAR}${c.reset}${paint.tint}${" ".repeat(text + 4)}${c.reset}`;
  return [
    blank,
    `${paint.accent}${BAR}${c.reset}${paint.tint}  ${c.fg}${words}${c.reset}${paint.tint}` +
      `${" ".repeat(gap)}${c.faint}${who}${c.reset}${paint.tint}  ${c.reset}`,
    blank
  ];
}

// The project a request landed in, or the agents holding it. A request that was
// never handed out is the desk agent's own work, so it says PILO. The colour is
// the one the tree gives that role, so the two read as the same thing.
function routedBadge(item, tree) {
  const parts = String(item.project || item.routed || "").split(", ").filter(Boolean);
  const plain = parts.length
    ? parts.length > 2
      ? `${parts[0]} +${parts.length - 1}`
      : parts.join(" · ")
    : "PILO";
  const paint = parts.length ? badgePaint(parts, tree) : BADGE.PILO;
  const label = ASCII || COLOR === "none" ? `[${plain}]` : smallCaps(plain);
  return { plain, width: cols(label), text: ASCII || COLOR === "none" ? label : `${paint.bg}${paint.fg}${label}${c.reset}` };
}

// Match on the agent names a request was routed to, and on the project names
// they answer for — the badge takes the colour of whoever holds it.
function badgePaint(parts, tree) {
  const pms = tree?.pms || [];
  const workers = pms.flatMap((pm) => pm.children || []);
  const owns = (agents) => agents.some((a) => parts.includes(a.name) || parts.includes(a.projectName));
  if (owns(pms)) return BADGE.PM;
  if (owns(workers)) return BADGE.WORKER;
  return BADGE.PM;
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

  // One line per agent: status dot, name, and the badge right behind the name —
  // its position follows the name's length rather than lining up in a column.
  // The status word sits at the right edge, and workers do without one: their
  // dot already says it.
  const STATUS = { running: c.amberBright, failed: c.redSoft, blocked: c.blue };
  const put = (indent, icon, name, tag, status, action, nameColor = c.fg) => {
    const prefix = indent ? `${" ".repeat(indent)}${c.branch}└${c.reset} ` : "";
    const tagWidth = cols(badgeText(tag));
    const stateWidth = status ? cols(status) + 1 : 0;
    // dot + space, then two spaces before the badge, then whatever the status
    // word needs on the right — the name gives up whatever is left.
    const room = width - indent - (indent ? 2 : 0) - 4 - tagWidth - stateWidth;
    const label = cut(name, Math.max(4, room));
    const used = indent + (indent ? 2 : 0) + 2 + cols(label) + 2 + tagWidth;
    const gap = Math.max(1, width - used - (status ? cols(status) : 0));
    const tone = STATUS[status] || c.faint;
    rows.push(
      `${prefix}${icon.color}${icon.icon}${c.reset} ${nameColor}${label}${c.reset}  ${badge(tag)}` +
        (status ? `${" ".repeat(gap)}${tone}${status}${c.reset}` : "")
    );
    actions.push(action);
    // A blank line under every agent, so one row's badge never sits against the
    // next one's.
    rows.push("");
    actions.push(action);
  };

  // A hairline closes each block: the desk agent, then each PM with its workers.
  const divider = () => {
    rows.push(`${c.hair}${"─".repeat(Math.max(4, width))}${c.reset}`);
    actions.push(null);
  };

  // The word on the right says what the agent is doing, in one token.
  const word = (agent, seen) =>
    agent.status === "blocked"
      ? "blocked"
      : agent.status === "failed"
        ? "failed"
        : agent.status === "unbound"
          ? "unbound"
          : agent.status === "running" || seen.busy
            ? "running"
            : "idle";

  const all = { type: "project", name: null };
  const piloSeen = sessionLine(tree.pilo, tree.pilo.status);
  put(0, statusIcon(tree.pilo.status, state.spin), tree.pilo.name, "PILO", word(tree.pilo, piloSeen), all);

  const pms = tree.pms;
  if (pms.length) divider();
  pms.forEach((pm) => {
    const seen = sessionLine(pm, pm.status);
    const filter = { type: "project", name: pm.projectName || pm.name };
    // The selection used to be a ◂ in front of the name. It is an East Asian
    // Ambiguous glyph, so terminals that draw those double-width knocked that
    // one row out of line. Colour costs no columns.
    const picked = state.filter === filter.name ? c.green : c.fg;
    // A running session spins even when Pilo has nothing on it.
    const pmIcon = seen.busy ? { icon: SPINNER[state.spin % SPINNER.length], color: c.amber } : statusIcon(pm.status, state.spin);
    put(2, pmIcon, pm.name, "PM", word(pm, seen), filter, picked);

    pm.children.forEach((w) => {
      const wSeen = sessionLine(w, w.status);
      const wIcon = wSeen.busy ? { icon: SPINNER[state.spin % SPINNER.length], color: c.amber } : statusIcon(w.status, state.spin);
      put(4, wIcon, w.name, "WORKER", "", filter, picked);
    });

    divider();
  });

  if (!pms.length) {
    rows.push(`${c.faint}Project agent 없음 — :dash 에서 등록${c.reset}`);
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
  const { marginX, railWidth } = paneWidths();
  const action = railWidth && x <= marginX + railWidth ? hit.rail : hit.main;
  if (!action) return;
  if (action.type === "dash") {
    spawn("open", [`${dashboardUrl}#${action.tab}`], { detached: true, stdio: "ignore" }).unref();
    return note("대시보드 Agents 탭을 열었다");
  }
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

let pasteSeq = 0;

// The draft holds this token verbatim; send() swaps it back for the real text.
function placeholderFor(text, lines) {
  pasteSeq += 1;
  const size = text.length >= 1000 ? `${(text.length / 1000).toFixed(1)}k자` : `${text.length}자`;
  const token = `⟦paste #${pasteSeq} · ${lines}줄 · ${size}⟧`;
  state.pastes.set(token, text);
  return token;
}

function expandPastes(text) {
  let out = text;
  for (const [token, value] of state.pastes) out = out.split(token).join(value);
  return out;
}

// The prompt occupies the full width minus the marker and its space.
// Mouse reporting hands drags to us, which is what stops the terminal from
// selecting text. Turning it off gives native selection back.
function setMouse(on) {
  state.mouse = on;
  process.stdout.write(on ? MOUSE_ON : MOUSE_OFF);
}

async function copyOut(label, text) {
  if (!text || !text.trim()) return note(`복사할 내용이 없다: ${label}`, { sticky: true });
  const done = await new Promise((resolve) => {
    const child = spawn("pbcopy");
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(text);
  });
  if (done) return note(`${label} 복사됨 (${text.length}자)`);
  const file = join(homedir(), ".pilo", "last-copy.txt");
  try {
    writeFileSync(file, text);
    return note(`클립보드 실패 — ${file} 에 저장했다`, { sticky: true });
  } catch (err) {
    return note(`복사 실패: ${err.message}`, { sticky: true });
  }
}

// One place decides the columns, so the renderer and the editor cannot disagree.
function paneWidths() {
  const width = process.stdout.columns || 120;
  const marginX = width > 60 ? 2 : 0;
  const outWidth = Math.max(40, width - marginX * 2);
  const railWidth = width >= 96 ? Math.min(40, Math.max(30, Math.round(width * 0.28))) : 0;
  const mainWidth = railWidth ? outWidth - railWidth - 3 : outWidth;
  return { width, marginX, outWidth, railWidth, mainWidth };
}

// The prompt lives inside the chat pane; ignoring the rail is what hid typing
// behind the agent tree.
function draftWidth() {
  const { mainWidth } = paneWidths();
  return Math.max(20, mainWidth - 2);
}

function scrollBy(rows) {
  if (rows < 0 && state.scroll === 0) state.pad = Math.max(0, state.pad + rows);
  const next = Math.max(0, Math.min(state.maxScroll, state.scroll + rows));
  if (next === state.scroll) return;
  state.scroll = next;
  render();
}

// The tree shows two things about an agent: the work Pilo gave it, and whether
// its session is actually running right now. No inference beyond that — a busy
// session is just a busy session, whoever started it.
function sessionLine(agent, base) {
  const seen = agent.sessionStatus || "";
  if (agent.status === "unbound") return { text: "세션 미연결", busy: false };
  const busy = seen === "working";
  const tail = busy ? "실행 중" : seen ? "대기" : "세션 끊김";
  if (agent.status === "idle") return { text: busy ? "실행 중" : tail === "대기" ? "idle" : tail, busy };
  return { text: `${base} · ${tail}`, busy };
}

function statusIcon(status, spin) {
  if (status === "running") return { icon: SPINNER[spin % SPINNER.length], color: c.amber };
  // waiting on a person, not on work: a spinner here would be a lie
  if (status === "blocked") return { icon: "◆", color: c.blue };
  if (status === "failed") return { icon: "✕", color: c.red };
  if (status === "unbound") return { icon: "○", color: c.faint };
  if (status === "queued") return { icon: "◍", color: c.faint };
  if (status === "archived") return { icon: "·", color: c.faint };
  return { icon: "●", color: c.green };
}

function render() {
  const height = process.stdout.rows || 34;
  const { width, marginX, outWidth, railWidth, mainWidth } = paneWidths();
  const pre = " ".repeat(marginX);

  if (!state.data) return;
  const { setup, tree, inbox, overview, settings } = state.data;
  const screen = [""];
  const emit = (text) => screen.push(text);

  const agentLabel = tree.pilo
    ? `${c.green}●${c.reset} ${c.bold}${c.fg}${tree.pilo.name} agent${c.reset}`
    : `${c.faint}● 대표 agent 없음${c.reset}`;
  const agentHome = pretty(tree.pilo?.cwd || launchCwd);
  const topLeft =
    `${c.bold}${c.strong}Pilo${c.reset} ${c.line}│${c.reset} ${agentLabel} ` +
    `${c.line}│${c.reset} ${c.faint}${agentHome}${c.reset}`;
  const topRight = `${c.faint}:help — commands${c.reset}`;
  emit(pre + cell(topLeft, outWidth - cols(topRight)) + topRight);
  emit(pre + line(outWidth));

  const running = tree.pms.filter((p) => p.status === "running").length;
  const statusLeft = `${c.green}●${c.reset} ${c.muted}herdr${c.reset} ${c.faint}${setup.herdr ? `connected · ${setup.sessions} sessions` : "not detected"}${c.reset}`;
  const statusMid = `${c.muted}pm${c.reset} ${c.fg}${overview.stats.pm}${c.reset} · ${c.muted}worker${c.reset} ${c.fg}${overview.stats.worker}${c.reset} · ${c.muted}running${c.reset} ${c.green}${running}${c.reset} · ${c.muted}failed${c.reset} ${c.red}${overview.stats.failed.total}${c.reset}`;
  const showTokens = settings.tokens?.showInTui !== false;
  const statusRight = showTokens
    ? ` ${c.line}│${c.reset} ${c.muted}tokens${c.reset} ${c.fg}${tokens(overview.stats.tokens.total)}${c.reset}`
    : "";
  const right = `${statusMid}${statusRight}`;
  const gap = Math.max(2, outWidth - cols(statusLeft) - cols(right));
  emit(pre + cut(`${statusLeft}${" ".repeat(gap)}${right}`, outWidth));
  emit(pre + line(outWidth));

  const visible = Math.max(8, height - 11);
  let rows = [];
  let rowActions = [];
  let waiting = 0;

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
      // questions carry tables too, and the raw pipes are just as unreadable there
      // Once a request has been handed out, the question wears the name of
      // whoever holds it. The badge takes its columns from the text so nothing
      // spills past the rail.
      const tagged = routedBadge(item, tree);
      const textWidth = mainWidth - 6 - (tagged.width + 1);
      const lines = wrap(alignTables(item.userRequest, textWidth), textWidth);
      const shownLines = folded ? lines.slice(0, 2) : lines;
      // The state of a request lives in its own mark rather than in a word: green
      // once answered, amber while the work is out, red when it needs a person.
      // Colour alone would strand anyone without it, so the colourless build
      // swaps the glyph instead.
      const mood = item.finalReply ? "done" : item.needsReply ? "attention" : "working";
      const glyph = COLOR === "none" ? { done: "❯", working: "»", attention: "!" }[mood] : "❯";
      const markColour = pulseColour(mood);
      const question = shownLines.map((x, i) => {
        const mark = i ? " " : markColour + glyph + c.reset;
        const tag = i ? " ".repeat(tagged.width) : tagged.text;
        return `  ${mark} ${tag} ${c.fg}${x}${c.reset}`;
      });
      if (folded && lines.length > shownLines.length) {
        question[question.length - 1] += `${c.faint} …${c.reset}`;
      }
      feed.push(...question);
      actions.push(...question.map(() => fold));
      feed.push("");
      actions.push(null);
      // The mark pulses whether or not the card is open, so a folded request
      // still keeps the clock running.
      if (!item.finalReply && !item.needsReply) waiting += 1;
      if (!folded) {
        // The bar lines up with the question's badge, not with the ❯: the mark and
        // the space after it are the two columns the card is indented past.
        const block = (item.finalReply ? replyBlock(item, mainWidth - 6, tagged) : waitingBlock(item, mainWidth - 6)).map((r) => "    " + r);
        feed.push(...block);
        // only the header line folds, so clicking inside an answer does nothing
        actions.push(...block.map((_row, i) => (i === 0 ? fold : null)));
        feed.push("");
        actions.push(null);
      }
    });
    for (const item of liveNotes()) {
      const tint = item.sticky ? c.red : c.muted;
      const lines = wrap(item.text, mainWidth - 8).map((x) => `  ${c.faint}pilo${c.reset} ${tint}${x}${c.reset}`);
      feed.push(...lines, "");
      actions.push(...lines.map(() => null), null);
    }
    if (feed.length <= (state.filter ? 2 : 0)) {
      feed.push(`  ${c.faint}${state.filter ? state.filter + " 프로젝트 요청 없음" : "아래 프롬프트에 지시를 입력하세요."} ${c.reset}`);
      actions.push(null);
    }
    rows = feed;
    rowActions = actions;
  }
  pulseWhile(waiting > 0);

  const railActions = [];
  const rail = railWidth ? railRows(tree, railWidth, railActions) : [];

  // A dotted box pinned to the bottom of the rail, inside the same slots the feed
  // uses, so no coordinate anywhere else moves.
  const draft = layoutDraft(state.input, draftWidth());
  // header rows: blank, title, rule, status, rule
  const HEAD_ROWS = 5;
  // one blank row stands between the feed and the prompt
  const filler = Math.max(0, height - HEAD_ROWS - visible - 1 - draft.length - 1);
  if (railWidth) {
    const label = "register agent - :dash agents";
    const inner = Math.max(cols(label) + 2, railWidth - 2);
    const room = inner - 2;
    const left = Math.max(0, Math.floor((room - cols(label)) / 2));
    const centred = " ".repeat(left) + label;
    const box = [
      `${c.line}╭${"─".repeat(inner)}╮${c.reset}`,
      `${c.line}│${c.reset} ${c.muted}${pad(cut(centred, room), room)}${c.reset} ${c.line}│${c.reset}`,
      `${c.line}╰${"─".repeat(inner)}╯${c.reset}`
    ];
    const open = { type: "dash", tab: "agents" };
    // The rail column keeps drawing to the bottom padding, so the box sits on the
    // last rows of the screen rather than inside the feed area.
    const slots = visible + 1 + draft.length + filler;
    if (rail.length <= slots - box.length) {
      while (rail.length < slots - box.length) {
        rail.push("");
        railActions.push(null);
      }
      rail.push(...box);
      for (const _ of box) railActions.push(open);
    }
  }

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
    // The tree goes first and the answer text last. Anything the width model
    // misjudges then only moves the tail of its own row, where nothing lines up
    // against anything — the rail and its divider are past caring by then.
    if (!railWidth) emit(pre + cut(shown[i] || "", mainWidth));
    else emit(pre + `${pad(cut(rail[i] || "", railWidth), railWidth)} ${c.line}│${c.reset} ${cut(shown[i] || "", mainWidth)}`);
    // screen[0] is a blank line, so the terminal row is index + 1
    state.hits.set(screen.length, { main: rowActions[first + i] || null, rail: railActions[i] || null });
  }

  // Everything below the feed keeps the divider so the rail reaches the bottom.
  let railTail = visible;
  // Rows under the feed carry rail content too, so their clicks must be recorded
  // as well — otherwise the register box draws but does nothing.
  const withRail = (text) => {
    if (!railWidth) return text;
    const action = railActions[railTail] || null;
    const row = `${pad(cut(rail[railTail] || "", railWidth), railWidth)} ${c.line}│${c.reset} ${cut(text, mainWidth)}`;
    railTail += 1;
    state.hits.set(screen.length + 1, { main: null, rail: action });
    return row;
  };

  // No hint bar, but the prompt still needs to be set apart from the feed.
  const ruleWidth = railWidth ? mainWidth : outWidth;
  emit(pre + withRail(`${c.rule}${"─".repeat(Math.max(2, ruleWidth))}${c.reset}`));

  const mainLeft = marginX + (railWidth ? railWidth + 3 : 0);
  let cursorRow = screen.length + 1;
  let cursorCol = mainLeft + 3;
  const PLACEHOLDER = "ask anything  ·  :dash for the dashboard";
  draft.forEach((row, i) => {
    const mark = i === 0 ? c.green + "❯" + c.reset : " ";
    const shown = i === 0 && !state.input ? `${c.faint}${PLACEHOLDER}${c.reset}` : row.text;
    emit(pre + withRail(`${mark} ${shown}`));
    const end = row.start + row.text.length;
    if (state.cursor >= row.start && (state.cursor <= end || i === draft.length - 1)) {
      cursorRow = screen.length;
      cursorCol = mainLeft + 3 + cols(row.text.slice(0, Math.max(0, state.cursor - row.start)));
    }
  });

  // Keep the divider going to the bottom, one row of padding left over.
  for (let i = 0; i < filler; i++) emit(pre + withRail(""));

  // One write per frame: home, each row cleared to end of line, then clear the
  // rest. Clearing the whole screen first is what made the display blink.
  process.stdout.write(
    "\x1b[H" + screen.map((row) => row + "\x1b[K").join("\n") + "\x1b[J" +
    `\x1b[${cursorRow};${cursorCol}H\x1b[?25h`
  );
}

// Command output is an answer to something the user just typed, not state: it
// says its piece and gets out of the way. Failures stay until the next one.
const NOTE_TTL = 8000;

function note(text, { sticky = false } = {}) {
  state.notes = state.notes.filter((n) => n.sticky !== true || sticky !== true);
  state.notes.push({ text, at: Date.now(), sticky });
  if (!sticky) setTimeout(render, NOTE_TTL + 50).unref?.();
}

function liveNotes() {
  const now = Date.now();
  state.notes = state.notes.filter((n) => n.sticky || now - n.at < NOTE_TTL);
  return state.notes.slice(-2);
}

async function command(parsed) {
  const word = parsed.name;
  const rest = parsed.args;
  if (word === "exit") return close();
  if (word === "dash") {
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
  if (word === "project") {
    const wanted = rest.join(" ").trim();
    const projects = [...new Set((state.data?.inbox || []).flatMap((i) => (i.project || "").split(", ").filter(Boolean)))];
    if (!wanted) {
      return note(`프로젝트: ${projects.join(" · ") || "없음"}   현재 필터: ${state.filter || "전체"}   (:project <이름> · :project all)`);
    }
    if (wanted === "all" || wanted === "전체") {
      applyProject(null);
      return;
    }
    const hit = projects.find((p) => p.toLowerCase() === wanted.toLowerCase());
    if (!hit) return note(`그런 프로젝트가 없다: ${wanted} (${projects.join(", ") || "등록된 프로젝트 없음"})`, { sticky: true });
    applyProject(hit);
    return;
  }
  if (word === "mouse") {
    const wanted = rest.join("").toLowerCase();
    const on = wanted ? ["on", "켜기", "true"].includes(wanted) : !state.mouse;
    setMouse(on);
    return note(
      on
        ? "마우스 켜짐 — 휠 스크롤과 클릭 접기 사용. 드래그 선택은 iTerm2 Option, kitty/WezTerm Shift"
        : "마우스 꺼짐 — 터미널 기본 드래그 선택으로 복사 가능. 스크롤은 PgUp/PgDn, 되돌리려면 :mouse"
    );
  }
  if (word === "copy") {
    const what = rest.join(" ").trim() || "last";
    if (what === "draft" || what === "입력") return copyOut("입력창", expandPastes(state.input));
    const inboxMatch = what.match(/^(?:in-)?(\d+)$/);
    if (inboxMatch) {
      const detail = await api(`/api/inbox/${inboxMatch[1]}`, null);
      if (!detail) return note(`in-${inboxMatch[1]} 을 찾을 수 없다`, { sticky: true });
      const reply = detail.replies[detail.replies.length - 1];
      return copyOut(`in-${detail.id}`, `요청: ${detail.userRequest}\n\n답변: ${reply?.body || "(아직 없음)"}`);
    }
    const taskMatch = what.match(/^task-?(\d+)$/);
    if (taskMatch) {
      const task = await api(`/api/tasks/${taskMatch[1]}`, null);
      if (!task) return note(`task #${taskMatch[1]} 을 찾을 수 없다`, { sticky: true });
      return copyOut(`task #${task.id}`, task.pmResult || task.request);
    }
    if (what === "last" || what === "마지막") {
      const answered = (state.data?.inbox || []).find((i) => i.finalReply);
      if (!answered) return note("복사할 답변이 아직 없다", { sticky: true });
      return copyOut(`in-${answered.id} 답변`, answered.finalReply);
    }
    return note("사용법: :copy [last | in-65 | task-389 | draft]", { sticky: true });
  }
  if (word === "blocked") {
    const rows = await api("/api/blocked", []);
    return note(rows.length ? rows.map((r) => `#${r.id} ${r.agent}: ${r.question}`).join("  │  ") : "결정 대기 없음");
  }
  if (word === "answer") {
    const [id, ...text] = rest;
    if (!id || !text.length) return note("사용법: /answer <taskId> <답변>");
    try {
      const res = await fetch(`${base}/api/tasks/${id}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: text.join(" ") })
      });
      const data = await res.json();
      return note(res.ok ? `#${id} 회신 저장 — agent 를 다시 깨웁니다` : `실패: ${data.error}`, { sticky: !res.ok });
    } catch (err) {
      return note(`실패: ${err.message}`, { sticky: true });
    }
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
      if (!ids.includes(target)) return note(`in-${target} 를 찾을 수 없다`, { sticky: true });
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
    return note(HELP);
  }
  return note(`unknown command: :${word} — :help 참고`, { sticky: true });
}

async function send(text) {
  const parsed = parseCommand(text.replace(/\n/g, " "));
  if (parsed) return command(parsed);
  const res = await fetch(`${base}/api/inbox`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userRequest: text, cwd: launchCwd })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return note(`요청 저장 실패: ${err.error || res.status}`, { sticky: true });
  }
}

function restoreTerminal() {
  // OSC 112 puts the cursor colour back to whatever the terminal had.
  process.stdout.write(MOUSE_OFF + "\x1b[?2004l\x1b[<u" + (COLOR === "none" ? "" : "\x1b]112\x07") + "\x1b[?1049l\x1b[23;0t");
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

// Arrows, curly quotes and box drawing are East Asian Ambiguous: one column in
// most terminals, two in the ones configured for CJK. Guessing wrong tilts every
// row that carries one, so print a → on a scratch line and ask where the cursor
// landed. Terminals that stay silent keep the one-column default.
function probeAmbiguous() {
  const forced = Number(process.env.PILO_AMBIGUOUS_WIDTH || 0);
  if (forced) {
    setAmbiguousWidth(forced, forced);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let seen = [];
    const done = () => {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      // Two answers, in the order the glyphs were printed: the arrow stands for
      // ambiguous text, the rule for the box drawing the layout is made of.
      if (seen.length >= 2) setAmbiguousWidth(seen[0] - 1, seen[1] - seen[0]);
      process.stdout.write("\x1b[H\x1b[2K");
      resolve();
    };
    const onData = (chunk) => {
      for (const hit of String(chunk).matchAll(/\x1b\[\d+;(\d+)R/g)) seen.push(Number(hit[1]));
      if (seen.length >= 2) done();
    };
    const timer = setTimeout(done, 200);
    process.stdin.on("data", onData);
    process.stdout.write("\x1b[H\x1b[2K→\x1b[6n─\x1b[6n");
  });
}

// Keys go through a filtered stream so mouse reports never reach readline.
const keys = new PassThrough();
readline.emitKeypressEvents(keys);
process.stdin.setRawMode(true);
// Ask for the kitty keyboard protocol so the terminal can tell Shift+Enter apart
// from Enter. Terminals without it ignore the request and Ctrl+J still works.
// Push the current title so it can be restored, then name the tab.
// iTerm draws "title (job)", so a title of our own would read "Pilo (Pilo)".
// Clear the title and let the process name alone name the tab.
process.title = "Pilo";
// The caret should read as part of the prompt, so it takes the accent green the
// ❯ is drawn in; OSC 112 in restoreTerminal puts the old colour back.
const cursorColour = COLOR === "none" ? "" : "\x1b]12;#3ed49c\x07";
process.stdout.write("\x1b[22;0t\x1b]1;\x07\x1b]2;\x07\x1b[?1049h\x1b[>1u\x1b[?2004h" + cursorColour + MOUSE_ON);

// The probe reads its own reply, so it runs before the key stream is wired up.
await probeAmbiguous();
process.stdin.on("data", (chunk) => {
  const { wheel, clicks, rest } = parseMouse(chunk);
  if (wheel) scrollBy(wheel * 3);
  for (const click of clicks) handleClick(click);
  if (rest.length) keys.write(rest);
});

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

  const page = Math.max(3, (process.stdout.rows || 34) - 12);
  if (key.name === "pageup" || (key.shift && key.name === "up")) return scrollBy(page);
  if (key.name === "pagedown" || (key.shift && key.name === "down")) return scrollBy(-page);

  // While a paste is in flight the characters go to a buffer, not the draft, so a
  // long blob can be swapped for a placeholder once we know how big it is.
  if (state.pasting && key.name !== "paste-end") {
    if (key.name === "return" || key.name === "enter") state.pasteBuffer += "\n";
    else if (ch && !key.ctrl && !key.meta) state.pasteBuffer += ch;
    return;
  }

  const next = edit({ input: state.input, cursor: state.cursor }, ch, key, {
    pasting: state.pasting,
    atoms: [...state.pastes.keys()],
    width: draftWidth()
  });
  if (next.action === "paste-start") {
    state.pasting = true;
    state.pasteBuffer = "";
    render();
    return;
  }
  if (next.action === "paste-end") {
    state.pasting = false;
    const text = state.pasteBuffer;
    state.pasteBuffer = "";
    const lines = text.split("\n").length;
    const inline = lines <= 2 && text.length <= 200;
    const insert = inline ? text : placeholderFor(text, lines);
    state.input = state.input.slice(0, state.cursor) + insert + state.input.slice(state.cursor);
    state.cursor += insert.length;
    state.scroll = 0;
    render();
    return;
  }
  if (next.action === "send") {
    const text = expandPastes(state.input).replace(/\s+$/, "");
    // A near-miss on a command is held back rather than sent: the draft stays put
    // so the fix is one edit away, and the desk agent is spared a typo to answer.
    const near = suggest(text);
    if (near) {
      note(`알 수 없는 명령입니다. 혹시 ${near.matches.map((x) => ":" + x).join(" 또는 ")}?`);
      return render();
    }
    state.input = "";
    state.cursor = 0;
    state.scroll = 0;
    state.pad = 0;
    state.pastes.clear();
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

// The waiting dot pulses, but only while there is a card to pulse: the timer is
// started by the render that draws one and cleared by the render that does not.
let pulseTimer = null;
function pulseWhile(alive) {
  if (alive && !pulseTimer) {
    pulseTimer = setInterval(() => {
      state.pulse = !state.pulse;
      render();
    }, 550);
    pulseTimer.unref?.();
  } else if (!alive && pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
    state.pulse = true;
  }
}

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
