// The same writes sent to two Pilo servers that start from the same data, each
// answer side by side, then the reads they lead to. Times are compared only as
// being times (the two servers write their own now()). Exit 1 on a difference.
//   node tools/compare-writes.mjs <node url> <rust url>
// Run it on a fresh pair: it writes, and the second run would start from rows
// the first one made.
const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error("usage: compare-writes.mjs <node url> <rust url>"); process.exit(2); }
const call = async (base, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
let reordered = 0;
function diffs(x, y, at = "", out = []) {
  if (out.length >= 8) return out;
  if (typeof x === "string" && typeof y === "string" && ISO.test(x) && ISO.test(y)) return out;
  if (Array.isArray(x) && Array.isArray(y) && tiesOnly(x, y) && x.some((r, i) => r.id !== y[i].id)) { reordered++; return out; }
  if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) out.push(`${at || "."} length ${x.length} != ${y.length}`);
    for (let i = 0; i < Math.min(x.length, y.length); i++) diffs(x[i], y[i], `${at}[${i}]`, out);
  } else if (x && y && typeof x === "object" && typeof y === "object") {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (!(k in y)) out.push(`${at}.${k} only in node`);
      else if (!(k in x)) out.push(`${at}.${k} only in rust`);
      else diffs(x[k], y[k], `${at}.${k}`, out);
    }
  } else if (x !== y) out.push(`${at || "."} ${JSON.stringify(x)?.slice(0, 90)} != ${JSON.stringify(y)?.slice(0, 90)}`);
  return out;
}
// what differs on purpose: each server names itself in a missing task's error
const loose = (d) => d.filter((line) => !/\.error "task #\d+ is not in this Pilo/.test(line));

// Rows a millisecond apart, or sharing a time, come back from Postgres in
// whatever order its plan meets them (Node's own new rows included). The same
// rows in another order is said as such, not passed silently.
const byId = (rows) => [...rows].sort((p, q) => Number(p.id) - Number(q.id));
const near = (x, y) => x.every((r, i) => r.id === y[i].id || Math.abs(Date.parse(r.createdAt) - Date.parse(x.find((o) => o.id === y[i].id)?.createdAt)) <= 2);
function tiesOnly(x, y) {
  if (!(x.length === y.length && x.length && x.every((r) => r && r.createdAt && r.id !== undefined) && near(x, y))) return false;
  const [p, q] = [byId(x), byId(y)];
  return p.every((r, i) => !diffs(r, q[i]).length);
}

let bad = 0, n = 0;
const both = async (method, path, body, note = "") => {
  const [x, y] = await Promise.all([call(a, method, path, body), call(b, method, path, body)]);
  const before = reordered;
  const d = x.status !== y.status ? [`status ${x.status} != ${y.status} ${JSON.stringify(x.body).slice(0, 120)} | ${JSON.stringify(y.body).slice(0, 120)}`] : loose(diffs(x.body, y.body));
  n++;
  if (d.length) bad++;
  else if (reordered > before) { console.log(`ok~ ${method} ${path}  (same rows; order differs only among rows 2 ms or less apart)`); return x.body; }
  console.log(`${d.length ? "DIFF" : "ok  "} ${method} ${path}${note ? `  (${note})` : ""}${d.length ? "\n       " + d.join("\n       ") : ""}`);
  return x.body;
};

const agents = (await call(a, "GET", "/api/agents")).body;
const pm = agents.find((x) => x.role === "pm" && agents.some((w) => w.parentAgentId === x.id));
const worker = agents.find((w) => w.parentAgentId === pm.id);
const lone = agents.find((x) => x.role === "pm" && !agents.some((w) => w.parentAgentId === x.id));
const sys = agents.find((x) => x.role === "system");

// requests and notes
const i1 = await both("POST", "/api/inbox", { userRequest: "conformance: first request 한국어도" });
await both("POST", "/api/inbox", { text: "by the text field", cwd: "/tmp" });
await both("POST", "/api/inbox", { userRequest: "   " }, "empty");
await both("POST", "/api/notes", { body: "a note\nwith two lines" });
await both("POST", "/api/notes", { text: "titled", title: "the title" });
await both("POST", "/api/notes", {}, "empty");
// tasks: to a PM, to its worker (parent found), to a system agent, to nobody
const t1 = await both("POST", `/api/inbox/${i1.id}/tasks`, { toAgentId: pm.id, request: "do the thing", title: "thing" });
const w1 = await both("POST", `/api/inbox/${i1.id}/tasks`, { toAgentId: worker.id, request: "the part" });
const i2 = await both("POST", "/api/inbox", { userRequest: "second" });
await both("POST", `/api/inbox/${i2.id}/tasks`, { toAgentId: worker.id, request: "wrong number" }, "corrected to the PM's request");
if (sys) await both("POST", `/api/inbox/${i1.id}/tasks`, { toAgentId: sys.id, request: "x" }, "system agent");
await both("POST", `/api/inbox/${i1.id}/tasks`, { toAgentId: 999999, request: "x" }, "no agent");
await both("POST", `/api/inbox/${i2.id}/tasks`, { toAgentId: worker.id, request: "standalone", standalone: true });
// progress, hold, resume
await both("POST", `/api/tasks/${t1.id}/progress`, { text: "reading the code" });
await both("POST", `/api/tasks/${t1.id}/progress`, { progress: "second note" });
await both("POST", `/api/tasks/${t1.id}/progress`, {}, "empty");
await both("POST", `/api/tasks/999999999/progress`, { text: "x" }, "no task");
await both("POST", `/api/tasks/${w1.id}/hold`, { note: "waiting on CI" });
await both("POST", `/api/tasks/${w1.id}/hold`, {});
await both("POST", `/api/tasks/${w1.id}/resume`, {});
// a block, the desk asking, an answer
await both("POST", `/api/tasks/${w1.id}/result`, { status: "blocked", pmResult: "may I deploy?", question: "may I deploy?" });
await both("POST", `/api/tasks/${t1.id}/result`, { status: "blocked", pmResult: "carrying it", relayOf: w1.id }, "relayed block");
await both("POST", `/api/tasks/${t1.id}/result`, { status: "blocked", pmResult: "x", relayOf: 999999 }, "relay of nothing");
await both("POST", `/api/tasks/${t1.id}/ask`, { body: "Deploy now, or after review?" });
await both("POST", `/api/tasks/${t1.id}/ask`, {}, "empty");
await both("GET", `/api/inbox/${i1.id}`);
await both("GET", "/api/overview?part=stats");
await both("POST", `/api/tasks/${t1.id}/answer`, { answer: "now" });
await both("POST", `/api/tasks/${t1.id}/answer`, { answer: "again" }, "not blocked any more");
await both("POST", `/api/tasks/${t1.id}/ask`, { body: "x" }, "not blocked");
// results, with artifacts and a run log, and a failure
await both("POST", `/api/tasks/${w1.id}/result`, { status: "done", pmResult: "deployed", tokensIn: 1200, tokensOut: "300",
  artifacts: [{ path: "src/a.js", delta: "+1 −0", diff: "+x" }], runLog: [{ t: "00:01", text: "ran" }] });
await both("POST", `/api/tasks/${t1.id}/result`, { pmResult: "all done", tokensIn: 10 });
const t3 = await both("POST", `/api/inbox/${i2.id}/tasks`, { toAgentId: lone.id, request: "will fail" });
await both("POST", `/api/tasks/${t3.id}/result`, { status: "failed", error: "SESSION_NOT_FOUND", pmResult: "could not" });
await both("POST", `/api/tasks/${t1.id}/progress`, { text: "late" }, "already done");
// replies
await both("POST", `/api/inbox/${i1.id}/reply`, { body: "here it is", withResults: true });
await both("POST", `/api/inbox/${i2.id}/reply`, { body: "short" });
const i3 = await both("POST", "/api/inbox", { userRequest: "nothing done" });
await both("POST", `/api/inbox/${i3.id}/reply`, { body: "x", withResults: true }, "nothing to attach");
// limits: a worker parked hands its untouched work to its PM
const i4 = await both("POST", "/api/inbox", { userRequest: "for the worker" });
await both("POST", `/api/inbox/${i4.id}/tasks`, { toAgentId: worker.id, request: "untouched", standalone: true });
await both("POST", `/api/agents/${worker.id}/limited`, { until: new Date(Date.now() + 3600e3).toISOString() });
await both("POST", `/api/agents/${worker.id}/limited`, { until: null });
await both("POST", `/api/agents/${worker.id}/limited`, { until: "not a time" });
await both("POST", `/api/agents/999999/limited`, {});
// standing jobs: each form of cadence, changes, a system job's limits
const sA = await both("POST", "/api/schedules", { toAgentId: pm.id, request: "weekly check", when: { repeat: "pick", at: "9:30", days: ["thu", "mon"] } });
await both("POST", "/api/schedules", { toAgentId: pm.id, request: "window", when: { repeat: "window", at: "09:00", until: "18:00", interval: 60, days: ["mon", "tue", "wed", "thu", "fri"] } });
await both("POST", "/api/schedules", { toAgentId: pm.id, request: "every other day", when: { repeat: "step", at: "14:00", interval: 2 } });
await both("POST", "/api/schedules", { toAgentId: pm.id, request: "plain", cadence: "08:15", weekdaysOnly: false, onMiss: "skip", name: "plain one" });
await both("POST", "/api/schedules", { toAgentId: pm.id, request: "every 45", cadence: "every:45" });
await both("POST", "/api/schedules", { toAgentId: pm.id, request: "x", cadence: "days:xyz@10:00" }, "bad cadence");
await both("POST", "/api/schedules", { toAgentId: pm.id, request: "x", when: { repeat: "window", at: "18:00", until: "09:00", interval: 30, days: ["mon"] } }, "window backwards");
await both("POST", "/api/schedules", { toAgentId: 999999, request: "x", cadence: "09:00" }, "no agent");
await both("POST", "/api/schedules", { toAgentId: pm.id, request: " ", cadence: "09:00" }, "empty");
await both("POST", `/api/schedules/${sA.id}`, { name: "renamed" }, "rename keeps the next run");
await both("POST", `/api/schedules/${sA.id}`, { enabled: false });
await both("POST", `/api/schedules/${sA.id}`, { enabled: true, when: { repeat: "daily", at: "07:00" } });
await both("POST", `/api/schedules/${sA.id}`, { toAgentId: worker.id, request: "moved" });
const system = (await call(a, "GET", "/api/schedules")).body.find((x) => x.kind === "system");
await both("POST", `/api/schedules/${system.id}`, { cadence: "every:15" });
await both("POST", `/api/schedules/${system.id}`, { cadence: "09:00" }, "system job wants every:N");
await both("DELETE", `/api/schedules/${system.id}`, undefined, "system job");
await both("DELETE", `/api/schedules/${sA.id}`);
await both("DELETE", `/api/schedules/${sA.id}`, undefined, "gone");
await both("GET", "/api/schedules");
// settings and projects
await both("PUT", "/api/settings/icons", { value: { on: true } });
await both("PUT", "/api/settings/nope", { value: 1 }, "unknown");
const pr = await both("POST", "/api/projects", { name: "conformance-project", repo: "x/y" });
await both("POST", "/api/projects", {}, "no name");
await both("PATCH", `/api/projects/${pr.id}`, { note: "a note" });
await both("DELETE", `/api/projects/${pr.id}`);
await both("GET", "/api/settings");
await both("GET", "/api/projects");
// what all of that reads as now
for (const p of ["/api/inbox?limit=10", `/api/inbox/${i1.id}`, `/api/inbox/${i2.id}`, `/api/tasks/${t1.id}`, `/api/tasks/${w1.id}`,
  "/api/overview?part=stats", "/api/agents", "/api/blocked", "/api/events", "/api/artifacts", `/api/replies?ids=${i1.id},${i2.id}`]) await both("GET", p);
console.log(`${n - bad}/${n} the same`);
process.exit(bad ? 1 : 0);
