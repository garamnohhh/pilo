// The wake rules, seen from outside: what reaches a pane (the fake herdr's log)
// and what the server records (/api/events), for a given world and requests.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer, team, events, sleep } from "./harness.js";

const scenario = (name, opts, body) => test(name, async () => {
  const srv = await startServer(opts);
  try { await body(srv); } finally { await srv.stop(); }
});

async function taskFor(srv, agentId, request = "do it") {
  const inbox = await srv.api("POST", "/api/inbox", { userRequest: request });
  const task = await srv.api("POST", `/api/inbox/${inbox.json.id}/tasks`, { toAgentId: agentId, request });
  assert.equal(task.status, 201, task.text);
  return { inbox: inbox.json.id, task: task.json.id };
}

// The pane has the text before the server has written wake_sent; a test that
// answers in between would see its answer land before the wake it answers.
const woken = (srv, t, who = "pm") => srv.waitFor(async () => srv.prompts(t.pane[who]).length
  && (await events(srv, "wake_sent")).some((e) => e.agent === { pm: "pm1", desk: "desk", worker: "wk1" }[who]), { what: `${who} wake` });

const ticks = (n = 4) => sleep(300 * n);   // PILO_WATCH_MS is 300 in the harness

scenario("a queued task wakes its agent once, then waits out the backoff", {}, async (srv) => {
  const t = await team(srv);
  const { task } = await taskFor(srv, t.ids.pm);
  await woken(srv, t);
  await ticks(6);
  assert.deepEqual(srv.prompts(t.pane.pm), [`[pilo:task] task #${task} - for pm1. read it with 'pilo task ${task}', report with 'pilo done ${task}'.`]);
});

scenario("a pane showing a dialog gets no wake; once it goes idle again the wake goes", {}, async (srv) => {
  const t = await team(srv, { screens: { "w1:p2": "Select model\n\n  1. Opus\n  2. Sonnet\n\nEnter to confirm · Esc to cancel" } });
  const { task } = await taskFor(srv, t.ids.pm);
  await srv.waitFor(async () => (await events(srv, "wake_failed")).length, { what: "dialog failure" });
  await ticks();
  assert.equal(srv.prompts(t.pane.pm).length, 0, "nothing typed into the dialog");
  t.set({ screens: {}, status: { pm: "working" } });
  await ticks(2);
  t.set({ status: { pm: "idle" } });
  await srv.waitFor(() => srv.prompts(t.pane.pm).some((m) => m.includes(`#${task}`)), { what: "wake after the dialog" });
});

scenario("a failed wake is not retried inside the first backoff step", {}, async (srv) => {
  const t = await team(srv, { fail: { "w1:p2": "boom" } });
  await taskFor(srv, t.ids.pm);
  await srv.waitFor(async () => (await events(srv, "wake_failed")).length, { what: "first failure" });
  await ticks(8);
  const tries = srv.calls().filter((a) => a[1] === "prompt" && a[2] === t.pane.pm && a[3].startsWith("[pilo:task]")).length;
  assert.equal(tries, 1, "one try, then the 90 s step");
});

scenario("over the hourly cap a wake is suppressed, not sent", { env: { PILO_WAKE_CAP: "2" } }, async (srv) => {
  const t = await team(srv);
  for (let i = 0; i < 3; i++) await taskFor(srv, t.ids.pm, `job ${i}`);
  await srv.waitFor(async () => (await events(srv, "wake_suppressed")).length, { what: "suppression" });
  assert.equal(srv.prompts(t.pane.pm).length, 2);
});

scenario("a limited agent is parked until the limit is lifted", {}, async (srv) => {
  const t = await team(srv);
  const lim = await srv.api("POST", `/api/agents/${t.ids.pm}/limited`, { until: new Date(Date.now() + 3600e3).toISOString() });
  assert.equal(lim.status, 201, lim.text);
  const { task } = await taskFor(srv, t.ids.pm);
  await srv.waitFor(async () => (await events(srv, "wake_parked")).length, { what: "parked" });
  assert.equal(srv.prompts(t.pane.pm).length, 0);
  await srv.api("POST", `/api/agents/${t.ids.pm}/limited`, { until: null });
  await srv.waitFor(() => srv.prompts(t.pane.pm).some((m) => m.includes(`#${task}`)), { what: "wake after the limit" });
});

scenario("the desk is held while it works, then told everything in one bundle", {}, async (srv) => {
  const t = await team(srv, { status: { desk: "working" } });
  await ticks(2);
  const a = await srv.api("POST", "/api/inbox", { userRequest: "first" });
  const b = await srv.api("POST", "/api/inbox", { userRequest: "second" });
  await ticks(4);
  assert.equal(srv.prompts(t.pane.desk).length, 0, "held while working");
  t.set({ status: { desk: "idle" } });
  await srv.waitFor(() => srv.prompts(t.pane.desk).length, { what: "desk bundle" });
  await ticks(2);
  const sent = srv.prompts(t.pane.desk);
  assert.equal(sent.length, 1, sent.join("\n"));
  assert.match(sent[0], /^\[pilo:batch\] 2 things for you, handle each: \(1\) /);
  assert.ok(sent[0].includes(`request #${a.json.id}`) && sent[0].includes(`request #${b.json.id}`));
});

scenario("the user's own requests reach the desk past the cap", { env: { PILO_WAKE_CAP: "1" } }, async (srv) => {
  const t = await team(srv);
  await srv.api("POST", "/api/inbox", { userRequest: "one" });
  await srv.waitFor(() => srv.prompts(t.pane.desk).length === 1, { what: "first" });
  await srv.api("POST", "/api/inbox", { userRequest: "two" });
  await srv.waitFor(() => srv.prompts(t.pane.desk).length === 2, { what: "second, cap-free" });
});

scenario("a blocked task wakes the desk once and reminds on its clock", { env: { PILO_DECISION_REMIND_MIN: "0.03" } }, async (srv) => {
  const t = await team(srv);
  const { task, inbox } = await taskFor(srv, t.ids.pm);
  await woken(srv, t);
  const r = await srv.api("POST", `/api/tasks/${task}/result`, { status: "blocked", pmResult: "ship?", question: "ship?" });
  assert.equal(r.status, 201, r.text);
  const want = `[pilo:blocked] task #${task} in request #${inbox} is waiting on the user`;
  await srv.waitFor(() => srv.prompts(t.pane.desk).some((m) => m.includes(want)), { what: "desk told of the decision" });
  await srv.waitFor(async () => (await events(srv, "decision_reminded")).length, { what: "reminder" });
  await ticks(4);
  assert.equal(srv.prompts(t.pane.desk).filter((m) => m.includes(want)).length, 1, "told once");
  assert.equal((await events(srv, "decision_woken")).length, 1);
});

scenario("an answered decision wakes the PM with the answer", {}, async (srv) => {
  const t = await team(srv);
  const { task } = await taskFor(srv, t.ids.pm);
  await woken(srv, t);
  await srv.api("POST", `/api/tasks/${task}/result`, { status: "blocked", pmResult: "ship?", question: "ship?" });
  const a = await srv.api("POST", `/api/tasks/${task}/answer`, { answer: "yes" });
  assert.equal(a.status, 201, a.text);
  await srv.waitFor(() => srv.prompts(t.pane.pm).some((m) => m.startsWith(`[pilo:task] decision returned #${task}`)), { what: "answer wake" });
});

scenario("a finished task tells the desk its results are in", {}, async (srv) => {
  const t = await team(srv);
  const { task, inbox } = await taskFor(srv, t.ids.pm);
  await woken(srv, t);
  await srv.api("POST", `/api/tasks/${task}/result`, { status: "done", pmResult: "done" });
  await srv.waitFor(() => srv.prompts(t.pane.desk).some((m) => m.includes(`[pilo:result] results in for #${inbox}`)), { what: "result wake" });
});

scenario("a session that comes back starts the wake clock over", {}, async (srv) => {
  const t = await team(srv, { fail: { "w1:p2": "boom" } });
  const { task } = await taskFor(srv, t.ids.pm);
  await srv.waitFor(async () => (await events(srv, "wake_failed")).length, { what: "failure" });
  // the pane goes away, then a new session is there
  srv.world({ agents: [{ pane_id: "w1:p1", agent: "claude", cwd: t.cwd.desk, agent_status: "idle" }] });
  await ticks(3);
  t.set({ fail: {} });
  await srv.waitFor(async () => (await events(srv, "session_started")).length, { what: "session back" });
  await srv.waitFor(() => srv.prompts(t.pane.pm).some((m) => m.includes(`#${task}`)), { what: "wake on the new session" });
});

scenario("a task gone quiet is marked stalled and nudged; a PM waiting on its worker is not", { env: { PILO_STALL_MIN: "0.03", PILO_NUDGE_EVERY_MIN: "60" } }, async (srv) => {
  const t = await team(srv);
  const { task, inbox } = await taskFor(srv, t.ids.pm);
  const sub = await srv.api("POST", `/api/inbox/${inbox}/tasks`, { toAgentId: t.ids.worker, request: "part" });
  const quiet = await taskFor(srv, t.ids.worker, "quiet one");
  await srv.waitFor(async () => (await events(srv, "task_stalled")).length, { what: "stall", ms: 15000 });
  await ticks(4);
  const stalled = await Promise.all((await events(srv, "task_stalled")).map(async (e) => (await srv.api("GET", `/api/events/${e.id}`)).json.taskId));
  assert.ok(!stalled.map(String).includes(String(task)), `the PM waits on #${sub.json.id}`);
  assert.ok(stalled.map(String).includes(String(quiet.task)));
  assert.equal(stalled.filter((id) => String(id) === String(quiet.task)).length, 1, "once per nudge window");
});

scenario("a held task is neither woken nor nudged until resumed", { env: { PILO_STALL_MIN: "0.03" } }, async (srv) => {
  const t = await team(srv);
  // parked while the task is made and held, so no wake can slip in before the hold
  await srv.api("POST", `/api/agents/${t.ids.pm}/limited`, { until: new Date(Date.now() + 3600e3).toISOString() });
  const { task } = await taskFor(srv, t.ids.pm);
  const h = await srv.api("POST", `/api/tasks/${task}/hold`, { note: "waiting on CI" });
  assert.equal(h.status, 201, h.text);
  await srv.api("POST", `/api/agents/${t.ids.pm}/limited`, { until: null });
  await ticks(8);
  assert.equal(srv.prompts(t.pane.pm).length, 0);
  assert.equal((await events(srv, "task_stalled")).length, 0);
  await srv.api("POST", `/api/tasks/${task}/resume`, {});
  await srv.waitFor(() => srv.prompts(t.pane.pm).some((m) => m.includes(`#${task}`)), { what: "wake after resume" });
});

scenario("registering a worker tells its PM and the desk their instructions changed", {}, async (srv) => {
  const t = await team(srv);
  await srv.waitFor(() => srv.prompts(t.pane.pm, { all: true }).some((m) => m.startsWith("[pilo:rules]")), { what: "pm told" });
  assert.ok(srv.prompts(t.pane.desk, { all: true }).some((m) => m.startsWith("[pilo:rules]")), "desk told");
  assert.ok(srv.prompts(t.pane.pm, { all: true }).find((m) => m.startsWith("[pilo:rules]")).includes(`${t.cwd.pm}/CLAUDE.md`));
});

const PROMPT = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel";

scenario("a worker's result waits on its PM's open prompt: one try a minute, not one a tick", {}, async (srv) => {
  const t = await team(srv);
  const { task, inbox } = await taskFor(srv, t.ids.pm);
  await woken(srv, t);
  const sub = await srv.api("POST", `/api/inbox/${inbox}/tasks`, { toAgentId: t.ids.worker, request: "part" });
  await srv.waitFor(() => srv.prompts(t.pane.worker).length, { what: "worker wake" });
  t.set({ screens: { "w1:p2": PROMPT } });
  await srv.api("POST", `/api/tasks/${sub.json.id}/result`, { status: "done", pmResult: "part done" });
  await srv.waitFor(async () => (await events(srv, "wake_failed")).length, { what: "first try into the prompt" });
  await ticks(10);
  assert.equal((await events(srv, "wake_failed")).length, 1, "11/11: 99 tries in five minutes");
  t.set({ screens: {}, status: { pm: "working" } });
  await ticks(2);
  t.set({ status: { pm: "idle" } });
  await srv.waitFor(() => srv.prompts(t.pane.pm).some((m) => m.startsWith(`[pilo:worker] task #${sub.json.id}`) && m.includes(`#${task}`)), { what: "the result once the prompt is gone" });
});

scenario("the desk's bundle waits on the desk's open prompt the same way", {}, async (srv) => {
  const t = await team(srv, { screens: { "w1:p1": PROMPT } });
  const { task } = await taskFor(srv, t.ids.pm);
  await srv.api("POST", `/api/tasks/${task}/result`, { status: "blocked", pmResult: "ship?" });
  await srv.waitFor(async () => (await events(srv, "wake_failed")).some((e) => e.agent === "desk"), { what: "first try into the desk's prompt" });
  // one try writes a failure per item it carried; what must not happen is another try
  await ticks(2);
  const first = (await events(srv, "wake_failed")).filter((e) => e.agent === "desk").length;
  await ticks(10);
  assert.equal((await events(srv, "wake_failed")).filter((e) => e.agent === "desk").length, first);
  t.set({ screens: {}, status: { desk: "working" } });
  await ticks(2);
  t.set({ status: { desk: "idle" } });
  await srv.waitFor(() => srv.prompts(t.pane.desk).some((m) => m.includes(`[pilo:blocked] task #${task}`)), { what: "the desk told once its prompt is gone" });
});
