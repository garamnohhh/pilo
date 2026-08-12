import { readFile, readdir } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseUrl } from "./paths.js";

export const root = normalize(join(fileURLToPath(import.meta.url), "../.."));

const connectionString = databaseUrl();

export const pool = new pg.Pool({ connectionString, max: 8 });

export async function query(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}

export async function one(text, params = []) {
  const rows = await query(text, params);
  return rows[0] || null;
}

// ponytail: migrations are plain files applied in filename order, tracked in one table.
export async function migrate() {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const applied = new Set((await query("SELECT filename FROM schema_migrations")).map((r) => r.filename));

  // The prototype ran 001 before this table existed. Record it instead of replaying it,
  // otherwise it would recreate the old agents table on top of the new one.
  if (!applied.size) {
    const legacy = await one(`SELECT 1 AS hit FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('agents', 'agents_legacy_001') LIMIT 1`);
    if (legacy) {
      await query("INSERT INTO schema_migrations (filename) VALUES ('001_init.sql') ON CONFLICT DO NOTHING");
      applied.add("001_init.sql");
    }
  }

  const dir = join(root, "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const ran = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      ran.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }

  return ran;
}

export async function getSetting(key, fallback = null) {
  const row = await one("SELECT value FROM settings WHERE key = $1", [key]);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
  return value;
}

export async function logEvent({ type, title = "", agentId = null, taskId = null, inboxId = null, payload = {}, runLog = [] }) {
  const row = await one(
    `INSERT INTO events (type, title, agent_id, task_id, inbox_id, payload, run_log)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) RETURNING id`,
    [type, title, agentId, taskId, inboxId, JSON.stringify(payload), JSON.stringify(runLog)]
  );
  return row.id;
}
