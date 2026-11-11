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
// and what each says about itself (pid, uptime, database engine, its files)
const IGNORE = { "/health": ["port", "streams"], "/api/tasks/999999999": ["error"], "/api/system": ["services", "paths"], "/api/overview": ["services", "paths"], "/api/setup": ["node"] };
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
  const id = async (p, i = 0) => (await get(a, p)).body?.[i]?.id;
  const inbox = (await get(a, "/api/inbox?limit=100")).body || [];
  // requests of every shape: answered, open, with decisions, slipped, scheduled
  const pick = [...new Set([inbox[0], inbox[1], inbox.find((r) => r.decision), inbox.find((r) => r.leak), inbox.find((r) => r.held),
    inbox.find((r) => r.source === "schedule"), inbox.find((r) => r.openCount > 0), inbox.at(-1)].filter(Boolean).map((r) => r.id))];
  const tasks = (await get(a, "/api/tasks")).body || [];
  // a done task only: reading a queued one marks it opened, on each side
  const doneTask = tasks.find((t) => t.status === "done")?.id;
  const sched = (await get(a, "/api/schedules")).body?.find((s) => s.kind !== "system")?.id;
  const everyAgent = ((await get(a, "/api/agents")).body || []).map((x) => x.id);
  const agentName = inbox.find((r) => r.routed)?.routed?.split(", ")[0] || "";
  return ["/health", "/api/events", `/api/events/${await id("/api/events")}`, "/api/events/999999999", "/api/artifacts",
    `/api/artifacts/${await id("/api/artifacts")}`, "/api/tasks", "/api/blocked", "/api/projects", "/api/schedules", "/api/settings",
    "/api/inbox", "/api/inbox?limit=100", "/api/inbox?replies=0&limit=20", `/api/inbox?before=${inbox[10]?.id}&limit=5`,
    `/api/inbox?agent=${encodeURIComponent(agentName)}&limit=10`, "/api/inbox/count", `/api/inbox/count?agent=${encodeURIComponent(agentName)}`,
    "/api/inbox/leaks", "/api/inbox/leaks?days=90", ...pick.map((i) => `/api/inbox/${i}`), "/api/inbox/999999999",
    `/api/replies?ids=${pick.join(",")}`, "/api/replies?ids=x", `/api/tasks/${doneTask}`, "/api/tasks/999999999",
    `/api/schedules/${sched}/runs`, "/api/history?q=pilo", "/api/history?q=%EA%B3%84%ED%9A%8D%20rust&limit=30",
    `/api/history?q=pilo&agent=${encodeURIComponent(agentName)}&since=2026-11-01`, "/api/history?q=", "/api/history?q=x&since=11-01",
    "/api/update", "/api/approvals", "/api/agents/1/session", "/api/agents/6/session", "/api/agents/999999/session",
    "/api/files/resolve?p=src/server.js&p=package.json&p=nope.md&p=public/*.png&p=~/workspace", "/api/files/resolve?p=README.md&base=" + encodeURIComponent(process.cwd()),
    ...everyAgent.map((i) => `/api/agents/${i}/rules`), "/api/agents/999999/rules",
    "/api/setup", "/api/agents", "/api/agents/tree", "/api/sessions", "/api/system", "/api/overview", "/api/overview?part=stats",
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
