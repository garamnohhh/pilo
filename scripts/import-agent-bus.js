// Import the agent-bus SQLite history into Pilo. The source database is opened
// read-only and never written to; re-running skips what is already there.
//
//   node scripts/import-agent-bus.js            # dry run, prints what it would do
//   node scripts/import-agent-bus.js --apply
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { query, one, pool } from "../src/db.js";

const BUS_ROOT = process.env.AGENT_BUS_ROOT || "/Users/garam/workspace/company/knowledge/actibooky.garam/AI/ai-config";
const BUS_DB = process.env.AGENT_BUS_DB || `${BUS_ROOT}/agent-bus/bus.db`;
const REGISTRY = process.env.AGENT_BUS_REGISTRY || `${BUS_ROOT}/registry/agents.tsv`;
const apply = process.argv.includes("--apply");

// bus.sh stores UTC strings like "2026-08-10 03:57:39".
const when = (value) => (value ? `${value.replace(" ", "T")}Z` : null);

// agent-bus knows agents by alias; Pilo knows them by cwd. The registry is the
// bridge, so renamed agents still line up.
async function agentMap() {
  const rows = await query("SELECT id, name, cwd FROM agents WHERE archived_at IS NULL");
  const byCwd = new Map(rows.map((a) => [a.cwd.replace(/\/+$/, ""), a]));
  const byName = new Map(rows.map((a) => [a.name, a]));
  const map = new Map();

  if (existsSync(REGISTRY)) {
    const lines = readFileSync(REGISTRY, "utf8").trim().split("\n").slice(1);
    for (const line of lines) {
      const [alias, , , , , cwd] = line.split("\t");
      const hit = byCwd.get((cwd || "").replace(/\/+$/, ""));
      if (alias && hit) map.set(alias, hit);
    }
  }
  // main was the desk agent; in Pilo that is whoever has role='pilo'.
  const pilo = rows.find((a) => a.name && byName.has(a.name) && a.name === "pilo") || null;
  if (!map.has("main") && pilo) map.set("main", pilo);
  for (const a of rows) if (!map.has(a.name)) map.set(a.name, a);
  return map;
}

async function main() {
  if (!existsSync(BUS_DB)) throw new Error(`agent-bus database not found: ${BUS_DB}`);
  const bus = new DatabaseSync(BUS_DB, { readOnly: true });
  const agents = await agentMap();

  const unknown = new Set();
  const resolve = (alias) => {
    const hit = agents.get(alias);
    if (!hit) unknown.add(alias);
    return hit?.id ?? null;
  };

  const userMessages = bus.prepare("SELECT * FROM user_messages ORDER BY id").all();
  const replies = bus.prepare("SELECT * FROM main_replies ORDER BY id").all();
  const tasks = bus.prepare("SELECT * FROM tasks ORDER BY id").all();
  const events = bus.prepare("SELECT * FROM events ORDER BY id").all();
  const messages = bus.prepare("SELECT * FROM messages ORDER BY id").all();

  console.log(`source: ${BUS_DB}`);
  console.log(
    `rows — user_messages ${userMessages.length}, main_replies ${replies.length}, ` +
      `tasks ${tasks.length}, events ${events.length}, messages ${messages.length}`
  );
  console.log("alias → pilo agent");
  for (const [alias, agent] of agents) console.log(`  ${alias.padEnd(10)} → ${agent.name}`);

  if (!apply) {
    const already = await one(
      `SELECT (SELECT count(*) FROM tasks WHERE legacy_id IS NOT NULL)::int AS tasks,
              (SELECT count(*) FROM inbox WHERE legacy_id IS NOT NULL)::int AS inbox`
    );
    console.log(`\nalready imported — inbox ${already.inbox}, tasks ${already.tasks}`);
    console.log("dry run. add --apply to write.");
    return;
  }

  const inboxIds = new Map();
  for (const m of userMessages) {
    const row = await one(
      `INSERT INTO inbox (user_request, status, created_at, updated_at, legacy_id)
       VALUES ($1, $2, $3, $3, $4)
       ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET user_request = EXCLUDED.user_request
       RETURNING id`,
      [m.body, m.status === "done" ? "replied" : "queued", when(m.created_at), m.id]
    );
    inboxIds.set(m.id, row.id);
  }

  let taskCount = 0;
  for (const t of tasks) {
    const inboxId = t.user_message_id ? inboxIds.get(t.user_message_id) ?? null : null;
    const row = await one(
      `INSERT INTO tasks (inbox_id, from_agent_id, to_agent_id, title, request, pm_result, status, error,
                          created_at, updated_at, claimed_at, done_at, legacy_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12)
       ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        inboxId,
        resolve(t.from_agent),
        resolve(t.to_agent),
        (t.subject || t.body || "").split("\n")[0].slice(0, 80),
        t.body,
        t.result || "",
        t.status === "done" ? "done" : t.status === "failed" ? "failed" : "queued",
        t.error || "",
        when(t.created_at),
        when(t.claimed_at),
        when(t.done_at),
        t.id
      ]
    );
    if (row) taskCount += 1;
  }

  let replyCount = 0;
  for (const r of replies) {
    const inboxId = inboxIds.get(r.user_message_id);
    if (!inboxId) continue;
    const row = await one(
      `INSERT INTO final_replies (inbox_id, agent_id, body, created_at, legacy_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [inboxId, agents.get("main")?.id ?? null, r.body, when(r.created_at), r.id]
    );
    if (row) replyCount += 1;
  }

  const taskByLegacy = new Map(
    (await query("SELECT id, legacy_id FROM tasks WHERE legacy_id IS NOT NULL")).map((r) => [Number(r.legacy_id), r.id])
  );

  let eventCount = 0;
  for (const e of events) {
    let payload = {};
    try {
      payload = JSON.parse(e.payload || "{}");
    } catch {
      payload = { raw: e.payload };
    }
    const row = await one(
      `INSERT INTO events (task_id, agent_id, type, title, payload, created_at, legacy_id, legacy_source)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'events')
       ON CONFLICT (legacy_source, legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        taskByLegacy.get(e.task_id) ?? null,
        resolve(e.agent),
        `bus_${e.type}`,
        `agent-bus #${e.task_id}`,
        JSON.stringify(payload),
        when(e.created_at),
        e.id
      ]
    );
    if (row) eventCount += 1;
  }

  let messageCount = 0;
  for (const m of messages) {
    const row = await one(
      `INSERT INTO events (task_id, agent_id, type, title, payload, created_at, legacy_id, legacy_source)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'messages')
       ON CONFLICT (legacy_source, legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        taskByLegacy.get(m.task_id) ?? null,
        resolve(m.from_agent),
        `bus_message_${m.kind}`,
        `${m.from_agent} → ${m.to_agent}`,
        JSON.stringify({ body: m.body, kind: m.kind, to: m.to_agent }),
        when(m.created_at),
        m.id
      ]
    );
    if (row) messageCount += 1;
  }

  console.log(
    `\nimported — inbox ${inboxIds.size}, tasks ${taskCount}, final_replies ${replyCount}, ` +
      `events ${eventCount}, messages ${messageCount}`
  );
  if (unknown.size) console.log(`매핑 못 한 alias: ${[...unknown].join(", ")}`);
  console.log(`source untouched: ${BUS_DB}`);
}

try {
  await main();
} finally {
  await pool.end();
}
