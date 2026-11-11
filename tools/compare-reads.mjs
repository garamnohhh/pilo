// The read paths of two Pilo servers on the same data, side by side: each path's
// status and JSON from both, and the first places they part. Exit 1 on a difference.
//   node tools/compare-reads.mjs <node url> <rust url> [path ...]
// With no paths: every GET the Rust server answers so far, with ids taken from
// the Node server's own lists.
const [a, b, ...given] = process.argv.slice(2);
if (!a || !b) { console.error("usage: compare-reads.mjs <node url> <rust url> [path ...]"); process.exit(2); }
const get = async (base, path) => {
  const r = await fetch(base + path);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text.length > 200 ? `<${text.length} bytes>` : text; }
  return { status: r.status, body };
};
// what differs on purpose: the port each listens on, and live SSE clients
const IGNORE = { "/health": ["port", "streams"] };
// where rows tie on every sort key, Postgres hands them back in storage order,
// which nothing promises; the same rows in another order is an explained difference
const TIES = { "/api/schedules": "system jobs share next_run_at" };
const sameRows = (x, y) => Array.isArray(x) && Array.isArray(y) && x.length === y.length
  && JSON.stringify(x.map(key).sort()) === JSON.stringify(y.map(key).sort());
const key = (r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]));

function diffs(x, y, at = "", out = []) {
  if (out.length >= 8) return out;
  if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) out.push(`${at || "."} length ${x.length} != ${y.length}`);
    for (let i = 0; i < Math.min(x.length, y.length); i++) diffs(x[i], y[i], `${at}[${i}]`, out);
  } else if (x && y && typeof x === "object" && typeof y === "object") {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (!(k in y)) out.push(`${at}.${k} only in node`);
      else if (!(k in x)) out.push(`${at}.${k} only in rust`);
      else diffs(x[k], y[k], `${at}.${k}`, out);
    }
  } else if (x !== y) out.push(`${at || "."} ${JSON.stringify(x)?.slice(0, 80)} != ${JSON.stringify(y)?.slice(0, 80)}`);
  return out;
}

async function paths() {
  if (given.length) return given;
  const id = async (p) => (await get(a, p)).body?.[0]?.id;
  return ["/health", "/api/events", `/api/events/${await id("/api/events")}`, "/api/events/999999999", "/api/artifacts",
    `/api/artifacts/${await id("/api/artifacts")}`, "/api/tasks", "/api/blocked", "/api/projects", "/api/schedules", "/api/settings",
    "/", "/dashboard.html", "/markdown.js", "/nope.txt"];
}

let bad = 0;
for (const p of await paths()) {
  const [x, y] = await Promise.all([get(a, p), get(b, p)]);
  for (const k of IGNORE[p] || []) { delete x.body?.[k]; delete y.body?.[k]; }
  let d = x.status !== y.status ? [`status ${x.status} != ${y.status}`] : diffs(x.body, y.body);
  if (d.length && TIES[p] && sameRows(x.body, y.body)) { console.log(`ok~ ${p}  (same rows, tie order: ${TIES[p]})`); continue; }
  if (d.length) bad++;
  console.log(`${d.length ? "DIFF" : "ok  "} ${p}${d.length ? "\n       " + d.join("\n       ") : ""}`);
}
process.exit(bad ? 1 : 0);
