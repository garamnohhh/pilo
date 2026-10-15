import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// a database of its own, set before anything reads the paths
const dir = mkdtempSync(join(tmpdir(), "pilo-reqstate-"));
process.env.PILO_HOME = dir;
process.env.PILO_DATA = join(dir, "data");
mkdirSync(join(dir, ".pilo"), { recursive: true });
const db = await import("./db.js");
await db.migrate();
const api = await import("./api.js");

const agent = (await db.one("INSERT INTO agents (name, role) VALUES ('desk', 'pilo') RETURNING id")).id;
const pm = (await db.one("INSERT INTO agents (name, role) VALUES ('web', 'pm') RETURNING id")).id;
const request = async (text) => (await db.one("INSERT INTO inbox (user_request) VALUES ($1) RETURNING id", [text])).id;
const task = async (inbox, status, doneAgo = null, updatedAgo = 0) => (await db.one(
  `INSERT INTO tasks (inbox_id, to_agent_id, status, done_at, updated_at)
   VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() - ($4::int || ' minutes')::interval END,
           now() - ($5::int || ' minutes')::interval) RETURNING id`,
  [inbox, pm, status, doneAgo, updatedAgo])).id;
const reply = (inbox, ago) => db.query(
  "INSERT INTO final_replies (inbox_id, agent_id, body, created_at) VALUES ($1, $2, 'answer', now() - ($3::int || ' minutes')::interval)",
  [inbox, agent, ago]);
const row = async (id) => (await api.listInbox(100)).find((r) => r.id === id);

test("answered while work is out: open count and who has it; done when it all landed", async () => {
  const id = await request("two places");
  await task(id, "done", 50);
  await task(id, "running");
  await reply(id, 40);
  let r = await row(id);
  assert.deepEqual([r.openCount, r.openBy, r.unreported, r.leak], [1, "web", 0, null]);
  await db.query("UPDATE tasks SET status = 'done', done_at = now() - interval '5 minutes' WHERE inbox_id = $1 AND status = 'running'", [id]);
  r = await row(id);
  assert.deepEqual([r.openCount, r.unreported, r.leak], [0, 1, null], "a result after the answer, too new to call a leak");
  await reply(id, 1);
  r = await row(id);
  assert.deepEqual([r.openCount, r.unreported, r.leak], [0, 0, null], "the follow-up said it: done");
});

test("slips: a late result nobody passed on, one passed on and not answered, stalled work, a failure under a finished answer", async () => {
  const unwoken = await request("unwoken");
  await reply(unwoken, 120);
  await task(unwoken, "done", 60);
  const unanswered = await request("unanswered");
  await reply(unanswered, 120);
  const t2 = await task(unanswered, "done", 60);
  await db.logEvent({ type: "followup_woken", taskId: t2, inboxId: unanswered });
  const stalled = await request("stalled");
  await reply(stalled, 300);
  await task(stalled, "running", null, 200);
  const failed = await request("failed");
  await reply(failed, 30);
  await task(failed, "failed", 20);
  // relay-werner, 10/15: the send the user denied failed first, the answer came after and said so
  const known = await request("failed, then answered");
  await task(known, "failed", 90);
  await reply(known, 30);
  assert.equal((await row(unwoken)).leak.kind, "unwoken");
  assert.equal((await row(unanswered)).leak.kind, "unanswered");
  assert.equal((await row(stalled)).leak.kind, "stalled");
  assert.equal((await row(failed)).leak.kind, "failed");
  assert.equal((await row(known)).leak, null, "the answer was written knowing it failed");
  const report = await api.inboxLeaks(14);
  assert.deepEqual(Object.fromEntries(Object.entries(report.kinds).map(([k, v]) => [k, v.count])), { unwoken: 1, unanswered: 1, stalled: 1, failed: 1 });
});
