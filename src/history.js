// `pilo history`: the desk's way back to what was asked, answered and reported
// after its own memory has been compacted or started over. Plain SQL does the
// finding — ILIKE, so a Korean word still matches with a particle stuck to it,
// which Postgres full-text search does not manage. This file turns the rows into
// short pieces, so one search never floods the desk's context.
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 30;
export const PIECE = 90;

// Every word has to turn up somewhere in the request; a handful is plenty.
export function terms(q) {
  return [...new Set(String(q || "").trim().split(/\s+/).filter(Boolean))].slice(0, 6);
}

// A word is looked for as typed: % and _ are characters, not wildcards.
export const likePattern = (word) => `%${String(word).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function piece(text, words, width = PIECE) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const at = Math.min(...words.map((w) => lower.indexOf(String(w).toLowerCase())).filter((i) => i >= 0));
  if (!Number.isFinite(at)) return null;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

// The request first, then the answer, then what the agents reported, then what
// they were told — a few pieces at most for one request.
export function pieces(fields, words, most = 3) {
  const out = [];
  for (const field of fields) {
    const text = piece(field.text, words);
    if (!text) continue;
    out.push({ field: field.field, agent: field.agent || "", text });
    if (out.length >= most) break;
  }
  return out;
}

export function kst(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(value));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// A day is a day in Seoul, where the user reads the dates.
export function sinceDate(text) {
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text))) {
    throw Object.assign(new Error("--since wants a date as YYYY-MM-DD"), { status: 400 });
  }
  const date = new Date(`${text}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error(`not a date: ${text}`), { status: 400 });
  return date;
}
