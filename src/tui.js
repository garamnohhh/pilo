import readline from "node:readline";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readPort } from "./paths.js";
import { edit, layoutDraft } from "./draft.js";
import { isPasteImage, takePasteKeys } from "./keys.js";
import { readQuota } from "./quota.js";
import { clipboardImage, droppedPaths, imageSize } from "./clipboard.js";
import { charWidth, cols, setAmbiguousWidth } from "./width.js";
import { t } from "./text.js";
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
  // work that has stopped moving: the same hue, without the light
  amberDim: fg(150, 128, 66),
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
// The badge used to be a fill with pale letters on it. The fill is gone and the
// colour it carried is now the letters' own — the same three hues, lifted until
// each clears 5.5:1 on a dark terminal, because the tones that read on a filled
// chip disappear on the background. Widths do not move: the fill hugged the
// letters and never added padding of its own.
const BADGE = {
  PILO: { fg: fg(88, 152, 123) },
  PM: { fg: fg(110, 144, 165) },
  WORKER: { fg: fg(123, 144, 135) },
  FINAL_REPLY: { fg: fg(88, 152, 123) }
};

// The badge used to be small caps. No terminal font we ship against has those
// letters — JetBrains Mono Nerd Font carries none of them — so every one of them
// was drawn by whatever fallback the terminal happened to pick, which is why the
// same badge looked right in one terminal and wrong in the next. Plain capitals
// are in every font; the colour already says which role it is.
const ASCII = process.argv.includes("--ascii");

// What an agent runs, worn in front of its name. Three tiers, and only the last
// one is guaranteed: a brand glyph where the icon font genuinely has one, a
// three-letter small-caps label otherwise, and plain capitals under --ascii or
// NO_COLOR. Icons are opt-in (PILO_ICONS=on) because nothing in a terminal can
// tell us whether the font in use actually carries them — a missing glyph draws
// a blank box, and a label is never wrong.
//
// Codepoints: codicon claude/openai/copilot came with Nerd Fonts 3.5.0
// (Codicons 0.0.45); the Google and X marks are Material Design, present since 3.x.
// Brand colours, taken from the makers' own pages rather than from memory:
// #d97757 is Anthropic's on anthropic.com, #4285f4 a stop in Gemini's own
// gradient on gemini.google.com, #f9f8f7 grok.com's light theme-color. OpenAI's
// and GitHub's marks are monochrome — the codicons are drawn in currentColor —
// so they get the light end of their own black-and-white palette. Every one of
// them clears 5:1 against a dark terminal, so none needed brightening.
const RUNTIME = {
  claude: { label: "CLD", icon: "\uec82", colour: fg(217, 119, 87) },
  codex: { label: "CDX", icon: "\uec81", colour: fg(255, 255, 255) },
  copilot: { label: "CPT", icon: "\uec1e", colour: fg(201, 209, 217) },
  gemini: { label: "GEM", icon: "\u{f02ad}", colour: fg(66, 133, 244) },
  grok: { label: "GRK", icon: "\u{f099}", colour: fg(249, 248, 247) },
  // herdr knows these too, and none of them has a mark of its own to draw.
  agy: { label: "AGY" },
  amp: { label: "AMP" },
  cline: { label: "CLN" },
  cursor: { label: "CUR" },
  devin: { label: "DVN" },
  droid: { label: "DRD" },
  hermes: { label: "HRM" },
  kilo: { label: "KIL" },
  kimi: { label: "KMI" },
  kiro: { label: "KIR" },
  maki: { label: "MAK" },
  mastracode: { label: "MST" },
  omp: { label: "OMP" },
  opencode: { label: "OPC" },
  pi: { label: "PI" },
  qodercli: { label: "QOD" },
  // Not in herdr's list, but common enough to name before it asks.
  aider: { label: "AID" },
  antigravity: { label: "AGY" },
  goose: { label: "GOS" },
  openai: { label: "CDX", icon: "\uec81", colour: fg(255, 255, 255) },
  qwen: { label: "QWN" },
  windsurf: { label: "WSF" }
};
// :icons decides, and what it decides is kept in the settings table so the next
// run starts the same way. PILO_ICONS only seeds the first run: the setting a
// user can see and change wins over an environment variable they cannot.
const ICONS_BY_ENV = process.env.PILO_ICONS !== "off";
const iconsWanted = () => {
  // What :icons said this run, then what the last run saved, then the
  // environment — which now defaults to on, so PILO_ICONS=off is the way to
  // start without them. The poll that refreshes the settings must not undo a
  // toggle the user can see on screen, so the session's own answer comes first.
  const saved = state.data?.settings?.icons;
  const wanted =
    typeof state.icons === "boolean" ? state.icons
      : typeof saved?.on === "boolean" ? saved.on
        : ICONS_BY_ENV;
  return wanted && !ASCII && COLOR !== "none";
};

// An unknown runtime keeps its own first three letters rather than a question
// mark: the name is the most useful thing we have, and it is never a lie. Icon
// and label wear the same colour, so turning icons off changes the shape of the
// mark and nothing else about it.
function runtimeMark(runtime) {
  const key = String(runtime || "").trim().toLowerCase();
  if (!key) return "";
  const known = RUNTIME[key];
  const glyph = iconsWanted() && known?.icon ? known.icon : null;
  const label = known?.label || key.slice(0, 3).toUpperCase();
  if (ASCII || COLOR === "none") return label;
  return `${known?.colour || c.faint}${glyph || label}${c.reset}`;
}

// No padding inside the badge: the fill hugs the letters, and the two spaces
// before it do the separating.
const badgeText = (tag) => (ASCII || COLOR === "none" ? `[${tag}]` : String(tag).toUpperCase());
function badge(tag) {
  const paint = BADGE[tag] || BADGE.WORKER;
  return ASCII || COLOR === "none" ? `[${tag}]` : `${paint.fg}${badgeText(tag)}${c.reset}`;
}

// Card surfaces: a tint painted to the card's full width, and the accent bar that
// stands in for a left border.
const CARD = {
  reply: { tint: bg(15, 19, 18) },
  waiting: { tint: bg(12, 16, 14) }
};
const BAR = "▌";
// The card sits past the question mark and its space; the same four columns are
// taken off the pane when working out how wide the card may be.
const CARD_INDENT = "    ";
// The tree's name and badge are two different things, so a short stroke stands
// between them. Measured in the terminal's own font at 32px, the box-drawing
// rule inks 48.6px — taller than the cell, which is why rows looked joined —
// while U+01C0 inks 23.3px and sits on the baseline, touching neither edge. The
// half-rules (╵ ╷) are shorter still but attach to the cell edge, which is the
// same problem again. Its advance is one cell and it is outside the East Asian
// ambiguous set, so no terminal draws it double. --ascii and NO_COLOR keep a
// pipe: same width, same job, and the bracketed badge reads without colour.
const SEPARATOR = "|";
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
  icons: null,
  cursor: 0,
  notes: [],
  mouse: true,
  pasting: false,
  pasteBuffer: "",
  pastes: new Map(),
  images: new Map(),
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

// The five-hour window, per runtime, beside the token count. The weekly figure
// is left out on purpose: it moves slowly, and the line is already full.
// A reading nobody has refreshed in half an hour is drawn faint — the number
// itself is still true, it is just older than the work.
// Past this the reading is drawn faint and carries its own age, because a
// percentage with no date on it is the one thing worse than no percentage:
// Codex only writes a new figure while it works, so an old one is normal there.
const STALE_MIN = 30;
const age = (min) => (min >= 90 ? `${Math.round(min / 60)}h` : `${Math.round(min)}m`);

function quotaLine(compact = false) {
  const quota = readQuota();
  const parts = [];
  for (const runtime of ["claude", "codex"]) {
    const found = quota[runtime];
    if (!found) continue;
    const stale = found.ageMin >= STALE_MIN;
    const level = found.percent >= 90 ? c.red : found.percent >= 70 ? c.amber : c.green;
    const at = found.resetsAt ? new Date(found.resetsAt) : null;
    const clock = at && !Number.isNaN(at.getTime())
      ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
      : "";
    const stamp = stale ? ` ~${age(found.ageMin)}` : clock ? ` ↻${clock}` : "";
    const body = `${found.percent}%${compact ? "" : stamp}`;
    parts.push(stale
      ? `${c.faint}${runtimeMark(runtime)} ${body}${c.reset}`
      : `${runtimeMark(runtime)} ${level}${body}${c.reset}`);
  }
  if (!parts.length) return "";
  return ` ${c.line}│${c.reset} ${parts.join(`${c.faint} · ${c.reset}`)}`;
}

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
  // The question above already names who answered, one badge each. The header
  // adds the names only when the badges had to collapse them into a count.
  const who = item.routed || "";
  const extra = who && tagged?.hidden ? ` ${c.green}${who}${c.reset}` : "";
  return cardBlock({
    box,
    title: `${badge("FINAL_REPLY")}${extra}`,
    titleColor: "",
    right: took ? `in-${item.id} · ${took}` : `in-${item.id}`,
    body: wrap(alignTables(item.finalReply, box - 5), box - 5),
    footer: t("card.replyFooter"),
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
      title: t("card.needsReply"),
      titleColor: c.red,
      right: `in-${item.id}`,
      body: [many ? t("card.needsReplyMany", { count: item.taskCount }) : t("card.needsReplyOne")],
      footer: `pilo inbox ${item.id} · pilo reply ${item.id} "…" · :dash`,
      surface: "reply",
      state: "attention"
    });
  }
  // Work in flight: one line — what the agent last said about it, and who is
  // holding it, pushed to the right edge. The bar itself does the pulsing now,
  // so the line starts at the same column as any other card's text.
  const paint = { ...CARD.waiting, accent: pulseColour("working") };
  const text = Math.max(8, box - 5);
  const said = item.progress || (item.routed ? t("card.waiting") : t("card.queued"));
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

// Who actually holds the request: one badge per agent, each in the colour its
// role wears in the tree, so a PM and its worker are told apart at a glance. A
// request nobody was given is the desk agent's own, and says PILO.
//
// Three names is where a row starts losing its question, so at most three are
// spelled out and the rest collapse into a count.
const BADGE_LIMIT = 3;
const NAME_LIMIT = 18;

function routedBadge(item, tree) {
  const names = String(item.routed || "").split(", ").map((x) => x.trim()).filter(Boolean);
  if (!names.length) {
    const label = ASCII || COLOR === "none" ? "[PILO]" : "PILO";
    return {
      shown: [],
      hidden: 0,
      width: cols(label),
      text: ASCII || COLOR === "none" ? label : `${BADGE.PILO.fg}${label}${c.reset}`
    };
  }

  const shown = names.slice(0, BADGE_LIMIT);
  const hidden = names.length - shown.length;
  const chip = (name, paint) => {
    const plain = cut(name, NAME_LIMIT);
    const label = ASCII || COLOR === "none" ? `[${plain}]` : plain;
    return { label, text: ASCII || COLOR === "none" ? label : `${paint.fg}${label}${c.reset}` };
  };
  const chips = shown.map((name) => chip(name, rolePaint(name, tree)));
  if (hidden) chips.push(chip(`+${hidden}`, BADGE.WORKER));
  // One space between chips: two would read as separate things rather than one
  // list of holders.
  return {
    shown,
    hidden,
    width: chips.reduce((n, x) => n + cols(x.label), 0) + (chips.length - 1),
    text: chips.map((x) => x.text).join(" ")
  };
}

// A name belongs to whichever row of the tree carries it.
function rolePaint(name, tree) {
  if (tree?.pilo && tree.pilo.name === name) return BADGE.PILO;
  const pms = tree?.pms || [];
  if (pms.some((pm) => pm.name === name)) return BADGE.PM;
  if (pms.flatMap((pm) => pm.children || []).some((w) => w.name === name)) return BADGE.WORKER;
  return BADGE.PM;
}

function setupScreen(setup, width) {
  const rows = [];
  rows.push(`${c.amber}●${c.reset} ${c.strong}${t("setup.title")}${c.reset}`);
  rows.push("");
  rows.push(`${c.muted}${t("setup.lead")}${c.reset}`);
  rows.push("");
  if (setup.duplicatePilo) {
    rows.push(`${c.red}●${c.reset} ${c.strong}${t("setup.duplicate", { count: setup.piloAgents.length })}${c.reset}`);
    rows.push(`${c.faint}${t("setup.duplicateHint")}${c.reset}`);
    for (const a of setup.piloAgents) rows.push(`  ${c.fg}${a.name}${c.reset} ${c.faint}${pretty(a.cwd)} · ${a.runtime || "runtime unknown"}${c.reset}`);
    rows.push("");
  }
  const steps = [
    [t("setup.docker"), setup.docker, t("setup.dockerOk"), ""],
    [t("setup.herdr"), setup.herdr, t("setup.herdrOk", { count: setup.sessions }), t("setup.herdrHint")],
    [t("setup.postgres"), setup.postgres, t("setup.postgresOk"), "pilo up"],
    [t("setup.desk"), setup.piloAgents.length === 1, t("setup.deskOk"), t("setup.register")],
    [t("setup.pm"), setup.pmCount > 0, t("setup.pmOk"), t("setup.register")]
  ];
  for (const [title, ok, desc, cmd] of steps) {
    const mark = ok ? `${c.green}✓${c.reset}` : `${c.faint}○${c.reset}`;
    rows.push(`${mark} ${ok ? c.muted : c.strong}${title}${c.reset}`);
    rows.push(`  ${c.faint}${cut(ok ? desc : cmd || desc, width - 4)}${c.reset}`);
  }
  rows.push("");
  rows.push(`${c.faint}${t("setup.open")}${c.reset}`);
  return rows;
}

function railRows(tree, width, actions = []) {
  const rows = [`${c.faint}${t("tree.title")}${c.reset}`, ""];
  actions.push(null, null);
  if (!tree.pilo) {
    rows.push(`${c.faint}${t("tree.noDesk")}${c.reset}`);
    actions.push(null);
    return rows;
  }

  // One line per agent: status dot, name, and the badge right behind the name —
  // its position follows the name's length rather than lining up in a column.
  // The status word sits at the right edge, and workers do without one: their
  // dot already says it.
  const STATUS = { running: c.amberBright, failed: c.redSoft, blocked: c.blue };
  const put = (indent, icon, name, tag, status, action, nameColor = c.fg, runtime = "") => {
    const prefix = indent ? `${" ".repeat(indent)}${c.branch}└${c.reset} ` : "";
    const tagWidth = cols(badgeText(tag));
    const stateWidth = status ? cols(status) + 1 : 0;
    // The runtime mark sits between the dot and the name, and costs a space of
    // its own. An agent with no bound session has no mark and no space either.
    const mark = runtimeMark(runtime);
    const markWidth = mark ? cols(mark) + 1 : 0;
    // A hairline between the name and the badge, dim enough to separate without
    // being read: it is the branch tone, the quietest thing already on the row.
    // It costs the two columns the plain gap did, plus its own.
    const sepWidth = cols(SEPARATOR) + 2;
    // dot + space, then the separator before the badge, then whatever the status
    // word needs on the right — the name gives up whatever is left.
    const room = width - indent - (indent ? 2 : 0) - 2 - sepWidth - markWidth - tagWidth - stateWidth;
    const label = cut(name, Math.max(4, room));
    const used = indent + (indent ? 2 : 0) + 2 + markWidth + cols(label) + sepWidth + tagWidth;
    const gap = Math.max(1, width - used - (status ? cols(status) : 0));
    const tone = STATUS[status] || c.faint;
    rows.push(
      `${prefix}${icon.color}${icon.icon}${c.reset} ${mark ? `${mark} ` : ""}${nameColor}${label}${c.reset} ${c.branch}${SEPARATOR}${c.reset} ${badge(tag)}` +
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
  // Giving up used to be a line in the events table and nothing on the screen:
  // the wake stopped and the tree still read "idle".
  const limited = (agent) => agent.limitedUntil && new Date(agent.limitedUntil).getTime() > Date.now();
  const word = (agent, seen) =>
    limited(agent)
      ? t("state.limited")
      : agent.gaveUp > 0 && agent.status !== "running"
      ? t("state.gaveUp")
      : agent.status === "running" && stalled(agent)
      ? t("state.stalled")
      : agent.status === "blocked"
      ? t("state.blocked")
      : agent.status === "failed"
        ? t("state.failed")
        : agent.status === "unbound"
          ? t("state.unbound")
          : agent.status === "running" || seen.busy
            ? t("state.running")
            : t("state.idle");

  const all = { type: "project", name: null };
  const piloSeen = sessionLine(tree.pilo, tree.pilo.status);
  put(0, statusIcon(tree.pilo.status, state.spin), tree.pilo.name, "PILO", word(tree.pilo, piloSeen), all, c.fg, tree.pilo.runtime);

  // The desk agent may hold workers of its own — odd jobs that belong to no
  // project — and they sit under it exactly as a PM's workers sit under theirs.
  (tree.pilo.children || []).concat(tree.orphanWorkers || []).forEach((w) => {
    const wSeen = sessionLine(w, w.status);
    put(2, statusIcon(w.status, state.spin, stalled(w)), w.name, "WORKER", word(w, wSeen), all, c.fg, w.runtime);
  });

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
    const pmIcon = statusIcon(pm.status, state.spin, stalled(pm));
    put(2, pmIcon, pm.name, "PM", word(pm, seen), filter, picked, pm.runtime);

    pm.children.forEach((w) => {
      const wSeen = sessionLine(w, w.status);
      const wIcon = statusIcon(w.status, state.spin, stalled(w));
      put(4, wIcon, w.name, "WORKER", "", filter, picked, w.runtime);
    });

    divider();
  });

  if (!pms.length) {
    rows.push(`${c.faint}${t("tree.noPm")}${c.reset}`);
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
  note(name ? t("note.filterOn", { project: name }) : t("note.filterOff"));
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
    return note(t("note.agentsTab"));
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
  const size = text.length >= 1000 ? `${(text.length / 1000).toFixed(1)}k chars` : `${text.length} chars`;
  const token = `⟦paste #${pasteSeq} · ${lines} lines · ${size}⟧`;
  state.pastes.set(token, text);
  return token;
}

function expandPastes(text) {
  let out = text;
  for (const [token, value] of state.pastes) out = out.split(token).join(value);
  // An image leaves the path behind, which is what the agent can actually open.
  for (const [token, path] of state.images) out = out.split(token).join(path);
  return out;
}

// The image marker is the twin of the paste marker: same brackets, its own
// count, and the shape of the thing rather than its length.
let imageSeq = 0;

function imageToken({ file, width, height, bytes, kind = "png" }) {
  imageSeq += 1;
  const size = bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
  const shape = width && height ? `${width}×${height} · ` : "";
  const token = `⟦image #${imageSeq} · ${shape}${kind} ${size}⟧`;
  state.images.set(token, file);
  return token;
}

function insertDraft(text) {
  state.input = state.input.slice(0, state.cursor) + text + state.input.slice(state.cursor);
  state.cursor += text.length;
  state.scroll = 0;
}

// Cmd+V can reach the TUI twice: the terminal pastes (nothing, when the
// clipboard holds only an image) and then sends the key itself. Two triggers,
// one intent, so a second attach on the heels of the first is dropped.
let lastAttach = 0;

async function attachClipboard({ quiet = false } = {}) {
  if (Date.now() - lastAttach < 1500) return;
  const found = await clipboardImage();
  // Text on the clipboard is the terminal's own business: it has already pasted
  // it by the time this runs, so saying anything would be noise.
  if (found.miss) {
    if (found.miss !== "text" && !quiet) note(t("note.noClipboardImage"));
    return;
  }
  lastAttach = Date.now();
  insertDraft(imageToken(found));
  render();
}

// A dropped file arrives as its path in the prompt. Turning it into the same
// marker means one kind of attachment downstream, whichever way it came in.
async function attachFiles(paths) {
  const { statSync } = await import("node:fs");
  for (const file of paths) {
    const { width, height } = await imageSize(file);
    const bytes = statSync(file).size;
    insertDraft(imageToken({ file, width, height, bytes, kind: file.split(".").pop().toLowerCase() }));
  }
  render();
}

// The prompt occupies the full width minus the marker and its space.
// Mouse reporting hands drags to us, which is what stops the terminal from
// selecting text. Turning it off gives native selection back.
function setMouse(on) {
  state.mouse = on;
  process.stdout.write(on ? MOUSE_ON : MOUSE_OFF);
}

async function copyOut(label, text) {
  if (!text || !text.trim()) return note(t("note.nothingToCopy") + `: ${label}`, { sticky: true });
  const done = await new Promise((resolve) => {
    const child = spawn("pbcopy");
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(text);
  });
  if (done) return note(t("note.copied", { what: `${label} (${text.length} chars)` }));
  const file = join(homedir(), ".pilo", "last-copy.txt");
  try {
    writeFileSync(file, text);
    return note(`clipboard unavailable — saved to ${file}`, { sticky: true });
  } catch (err) {
    return note(`copy failed: ${err.message}`, { sticky: true });
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
// herdr reads the pane and guesses; Pilo knows what it handed out. The guess is
// only allowed to say "working" about work Pilo actually gave the agent —
// otherwise a shell prompt that herdr mistakes for a running job leaves an idle
// agent spinning in the tree for as long as the pane sits there.
// Nothing here kills a task or changes a record: this only decides what the row
// says. Ten minutes of silence from the work an agent holds, on a session that
// is idle or finished, is the pair of signals that means it stopped without
// reporting. Either one alone is normal — agents think for a long time between
// progress lines, and a busy pane may be the user typing into it.
const STALL_MS = 10 * 60 * 1000;
function stalled(agent) {
  if (agent.status !== "running" || !agent.lastSignal) return false;
  if (agent.sessionStatus === "working") return false;
  return Date.now() - new Date(agent.lastSignal).getTime() > STALL_MS;
}

function sessionLine(agent, base) {
  const seen = agent.sessionStatus || "";
  if (agent.status === "unbound") return { text: t("tree.sessionOff"), busy: false };
  const busy = seen === "working" && agent.status === "running";
  const tail = busy ? t("tree.sessionBusy") : seen ? t("tree.sessionQuiet") : t("tree.sessionGone");
  if (agent.status === "idle") return { text: busy ? t("tree.sessionBusy") : seen ? t("state.idle") : tail, busy };
  return { text: `${base} · ${tail}`, busy };
}

function statusIcon(status, spin, stopped = false) {
  // A stalled task keeps its place in the tree but stops pretending to move.
  if (status === "running" && stopped) return { icon: "◌", color: c.amberDim };
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

  const agentHome = pretty(tree.pilo?.cwd || launchCwd);
  // The wordmark, as the handoff draws it: an accent caret against the word in
  // the mono face at 600. A terminal has no letter-spacing, so the design's
  // -0.03em cannot be carried and bold stands in for 600; the 0.34em between
  // the caret and the word rounds up to the one thing a terminal has, a cell.
  const wordmark = `${c.green}❯${c.reset} ${c.bold}${c.strong}pilo${c.reset}`;
  // The desk agent's name was here too, and said nothing the tree below does
  // not say better. The path is what this line is for.
  const topLeft = `${wordmark} ${c.line}│${c.reset} ${c.faint}${agentHome}${c.reset}`;
  const topRight = `${c.faint}${t("header.help")}${c.reset}`;
  emit(pre + cell(topLeft, outWidth - cols(topRight)) + topRight);
  emit(pre + line(outWidth));

  const running = tree.pms.filter((p) => p.status === "running").length;
  const statusLeft = `${c.green}●${c.reset} ${c.muted}herdr${c.reset} ${c.faint}${setup.herdr ? `connected · ${setup.sessions} sessions` : "not detected"}${c.reset}`;
  const statusMid = `${c.muted}pm${c.reset} ${c.fg}${overview.stats.pm}${c.reset} · ${c.muted}worker${c.reset} ${c.fg}${overview.stats.worker}${c.reset} · ${c.muted}running${c.reset} ${c.green}${running}${c.reset} · ${c.muted}failed${c.reset} ${c.red}${overview.stats.failed.total}${c.reset}`;
  const showTokens = settings.tokens?.showInTui !== false;
  const tokenPart = showTokens
    ? ` ${c.line}│${c.reset} ${c.muted}tokens${c.reset} ${c.fg}${tokens(overview.stats.tokens.total)}${c.reset}`
    : "";
  // The reset clocks are the first thing to go on a narrow terminal: a truncated
  // "↻21:…" is worse than no clock at all.
  let right = `${statusMid}${tokenPart}${quotaLine()}`;
  if (cols(statusLeft) + cols(right) + 2 > outWidth) right = `${statusMid}${tokenPart}${quotaLine(true)}`;
  // Narrower still: drop it altogether rather than show half a number.
  if (cols(statusLeft) + cols(right) + 2 > outWidth) right = `${statusMid}${tokenPart}`;
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
      feed.push(`  ${c.faint}${t("feed.filter", { project: state.filter })}${c.reset}`);
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
        // the space after it are the two columns the card is indented past. What
        // is left of the pane after that indent is the card, to the column: the
        // card used to stop four short of the pane edge, which read as a ragged
        // right against the header above it.
        const room = mainWidth - CARD_INDENT.length;
        const block = (item.finalReply ? replyBlock(item, room + 2, tagged) : waitingBlock(item, room + 2)).map((r) => CARD_INDENT + r);
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
      feed.push(`  ${c.faint}${state.filter ? t("feed.emptyFiltered", { project: state.filter }) : t("feed.empty")} ${c.reset}`);
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
    const label = t("tree.register");
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
    shown[0] = `  ${c.faint}${t("feed.scrolled", { count: state.scroll })}${c.reset}`;
  } else if (state.maxScroll > 0) {
    shown[0] = `  ${c.faint}${t("feed.older", { count: state.maxScroll })}${c.reset}`;
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
  const PLACEHOLDER = t("feed.placeholder");
  // Both markers are drawn in a colour of their own so an image does not read as
  // a blob of pasted text. A marker split across two rows keeps the plain text,
  // which is only ever a cosmetic loss.
  const MARKER = /⟦(image|paste)[^⟧]*⟧/g;
  const paint = (text) =>
    COLOR === "none" ? text : text.replace(MARKER, (mark, kind) => `${kind === "image" ? c.blue : c.muted}${mark}${c.reset}`);
  draft.forEach((row, i) => {
    const mark = i === 0 ? c.green + "❯" + c.reset : " ";
    const shown = i === 0 && !state.input ? `${c.faint}${PLACEHOLDER}${c.reset}` : paint(row.text);
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
    return note(t("note.dashOpened"));
  }
  if (word === "agents") {
    const tree = await api("/api/agents/tree", { pilo: null, pms: [] });
    if (!tree.pilo) return note(t("note.noAgents"));
    const parts = [`${tree.pilo.name} ●`];
    for (const pm of tree.pms) parts.push(`${pm.name} ${pm.status} (${pm.children.map((w) => w.name).join(", ") || "no workers"})`);
    return note(parts.join(" │ "));
  }
  if (word === "inbox") {
    const inbox = await api("/api/inbox", []);
    const pending = inbox.filter((i) => i.status !== "replied");
    return note(pending.length ? pending.map((i) => `in-${i.id} ${i.status}`).join(" · ") : "nothing pending");
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
      return note(t("note.projects", { list: projects.join(" · ") || t("note.none"), current: state.filter || t("note.all") }));
    }
    if (wanted === "all" || wanted === "전체") {
      applyProject(null);
      return;
    }
    const hit = projects.find((p) => p.toLowerCase() === wanted.toLowerCase());
    if (!hit) return note(`no such project: ${wanted} (${projects.join(", ") || "none registered"})`, { sticky: true });
    applyProject(hit);
    return;
  }
  if (word === "icons") {
    const wanted = rest.join("").toLowerCase();
    const on = wanted ? ["on", "켜기", "true"].includes(wanted) : !iconsWanted();
    // Write it through the API so the dashboard and the next run agree; the
    // screen follows the session's own answer without waiting for the poll.
    state.icons = on;
    await fetch(`${base}/api/settings/icons`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: { on } })
    }).catch(() => {});
    return note(on ? t("note.iconsOn") : t("note.iconsOff"));
  }
  if (word === "mouse") {
    const wanted = rest.join("").toLowerCase();
    const on = wanted ? ["on", "켜기", "true"].includes(wanted) : !state.mouse;
    setMouse(on);
    return note(
      on
        ? t("note.mouseOn")
        : t("note.mouseOff")
    );
  }
  if (word === "copy") {
    const what = rest.join(" ").trim() || "last";
    if (what === "draft" || what === "입력") return copyOut("draft", expandPastes(state.input));
    const inboxMatch = what.match(/^(?:in-)?(\d+)$/);
    if (inboxMatch) {
      const detail = await api(`/api/inbox/${inboxMatch[1]}`, null);
      if (!detail) return note(`in-${inboxMatch[1]} not found`, { sticky: true });
      const reply = detail.replies[detail.replies.length - 1];
      return copyOut(`in-${detail.id}`, `${detail.userRequest}\n\n${reply?.body || "(no reply yet)"}`);
    }
    const taskMatch = what.match(/^task-?(\d+)$/);
    if (taskMatch) {
      const task = await api(`/api/tasks/${taskMatch[1]}`, null);
      if (!task) return note(`task #${taskMatch[1]} not found`, { sticky: true });
      return copyOut(`task #${task.id}`, task.pmResult || task.request);
    }
    if (what === "last" || what === "마지막") {
      const answered = (state.data?.inbox || []).find((i) => i.finalReply);
      if (!answered) return note(t("note.nothingToCopy"), { sticky: true });
      return copyOut(`in-${answered.id} reply`, answered.finalReply);
    }
    return note(t("note.copyUsage"), { sticky: true });
  }
  if (word === "schedules") {
    const rows = await api("/api/schedules", []);
    if (!rows.length) return note(t("note.noSchedules"));
    return note(
      rows
        .map((s) => `${s.id} ${s.enabled ? "" : "(off) "}${s.cadence} → ${s.agent} · ${new Date(s.nextRunAt).toLocaleString()}`)
        .join("  │  ")
    );
  }
  if (word === "schedule") {
    const [id, verb] = rest;
    if (!id || !["on", "off", "rm"].includes(verb)) return note(t("note.scheduleUsage"));
    const res = await fetch(`${base}/api/schedules/${id}`, {
      method: verb === "rm" ? "DELETE" : "POST",
      headers: { "content-type": "application/json" },
      body: verb === "rm" ? undefined : JSON.stringify({ enabled: verb === "on" })
    }).catch(() => null);
    if (!res?.ok) return note(t("note.scheduleFailed", { id }), { sticky: true });
    return note(t(verb === "rm" ? "note.scheduleRemoved" : verb === "on" ? "note.scheduleOn" : "note.scheduleOff", { id }));
  }
  if (word === "blocked") {
    const rows = await api("/api/blocked", []);
    return note(rows.length ? rows.map((r) => `#${r.id} ${r.agent}: ${r.question}`).join("  │  ") : t("note.noBlocked"));
  }
  if (word === "answer") {
    const [id, ...text] = rest;
    if (!id || !text.length) return note(t("note.answerUsage"));
    try {
      const res = await fetch(`${base}/api/tasks/${id}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: text.join(" ") })
      });
      const data = await res.json();
      return note(res.ok ? t("note.answered", { id }) : `failed: ${data.error}`, { sticky: !res.ok });
    } catch (err) {
      return note(`failed: ${err.message}`, { sticky: true });
    }
  }
  if (word === "fold" || word === "unfold") {
    const target = rest.join("").replace(/^in-/, "");
    const ids = (state.data?.inbox || []).map((i) => String(i.id));
    if (target === "default") {
      state.folded.clear();
      state.unfolded.clear();
      return note(`back to the default — newest ${OPEN_BY_DEFAULT} open`);
    }
    if (target && target !== "all") {
      if (!ids.includes(target)) return note(`in-${target} not found`, { sticky: true });
      if (word === "fold") {
        state.folded.add(target);
        state.unfolded.delete(target);
      } else {
        state.unfolded.add(target);
        state.folded.delete(target);
      }
      return note(`in-${target} ${word === "fold" ? "folded" : "open"}`);
    }
    if (word === "fold") {
      state.unfolded.clear();
      ids.forEach((id) => state.folded.add(id));
    } else {
      state.folded.clear();
      ids.forEach((id) => state.unfolded.add(id));
    }
    return note(word === "fold" ? `folded all (${ids.length})` : `opened all (${ids.length})`);
  }
  if (word === "help") {
    return note(HELP);
  }
  return note(t("note.unknown", { word }), { sticky: true });
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
    return note(t("note.sendFailed", { reason: err.error || res.status }), { sticky: true });
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
    setAmbiguousWidth(forced, forced, 1);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let seen = [];
    const done = () => {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      // Three answers, in the order the glyphs were printed: the arrow stands for
      // ambiguous text, the rule for the box drawing the layout is made of, and
      // the icon for the Private Use Area — one cell in a Nerd Font "Mono"
      // build, two in a normal one, and the terminal is the only one who knows.
      if (seen.length >= 2) setAmbiguousWidth(seen[0] - 1, seen[1] - seen[0], seen[2] ? seen[2] - seen[1] : 1);
      process.stdout.write("\x1b[H\x1b[2K");
      resolve();
    };
    const onData = (chunk) => {
      for (const hit of String(chunk).matchAll(/\x1b\[\d+;(\d+)R/g)) seen.push(Number(hit[1]));
      if (seen.length >= 3) done();
    };
    const timer = setTimeout(done, 200);
    process.stdin.on("data", onData);
    process.stdout.write("\x1b[H\x1b[2K→\x1b[6n─\x1b[6n\uec82\x1b[6n");
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
// Half a sequence waits here for the rest of itself.
let pasteCarry = "";
process.stdin.on("data", (chunk) => {
  const { wheel, clicks, rest } = parseMouse(chunk);
  if (wheel) scrollBy(wheel * 3);
  for (const click of clicks) handleClick(click);
  // Take the paste keys out here rather than after readline: a stray tail of one
  // of these was ending up in the prompt as text.
  const taken = takePasteKeys(rest, pasteCarry);
  pasteCarry = taken.carry;
  for (let i = 0; i < taken.hits; i++) attachClipboard();
  if (taken.rest.length) keys.write(taken.rest);
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

  if (isPasteImage(key)) return attachClipboard();

  const next = edit({ input: state.input, cursor: state.cursor }, ch, key, {
    pasting: state.pasting,
    atoms: [...state.pastes.keys(), ...state.images.keys()],
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
    // An image on the clipboard gives the terminal nothing to paste, so an empty
    // paste is the one hint that arrives without any terminal configuration.
    if (!text) return attachClipboard({ quiet: true });
    const dropped = droppedPaths(text);
    if (dropped.length) return attachFiles(dropped);
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
      note(t("note.didYouMean", { names: near.matches.map((x) => ":" + x).join(" / ") }));
      return render();
    }
    state.input = "";
    state.cursor = 0;
    state.scroll = 0;
    state.pad = 0;
    state.pastes.clear();
    state.images.clear();
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
