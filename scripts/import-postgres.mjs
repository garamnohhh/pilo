#!/usr/bin/env node
// Move an existing Pilo database out of PostgreSQL and into PGlite.
//
//   node scripts/import-postgres.mjs <dump.sql>
//
// Take the dump first, from the machine that still runs the container:
//   docker exec pilo-postgres pg_dump -U pilo -d pilo --no-owner --no-privileges --inserts > pilo.sql
//
// --inserts matters: a plain dump uses COPY ... FROM stdin, which only psql can
// read. Two psql-only lines (\restrict, \unrestrict) are dropped here, and the
// search_path the dump leaves empty is put back, or the next query in this
// connection would not find its own tables.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { dataDir, lockFile } from "../src/paths.js";
import { existsSync, mkdirSync, readFileSync as read } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/import-postgres.mjs <dump.sql>");
  process.exit(1);
}

if (existsSync(lockFile())) {
  const pid = Number(read(lockFile(), "utf8").trim());
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  if (alive) {
    console.error(`a Pilo server (pid ${pid}) has this database open. Stop it first: pilo stop`);
    process.exit(1);
  }
}

const sql = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => !/^\\(restrict|unrestrict)\b/.test(line))
  .join("\n");

mkdirSync(dataDir(), { recursive: true });
const db = await PGlite.create({ dataDir: dataDir(), extensions: { vector } });
const before = await db.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
if (before.rows[0].n > 0) {
  console.error(`${dataDir()} already holds ${before.rows[0].n} tables. Import into an empty database.`);
  await db.close();
  process.exit(1);
}

const started = Date.now();
await db.exec(sql);
await db.exec("SELECT pg_catalog.set_config('search_path', 'public', false);");

const counts = [];
for (const table of ["agents", "projects", "inbox", "tasks", "events", "final_replies", "artifacts", "schedules"]) {
  const r = await db.query(`SELECT count(*)::int AS n FROM ${table}`).catch(() => null);
  if (r) counts.push(`${table} ${r.rows[0].n}`);
}
await db.close();

console.log(`imported into ${dataDir()} in ${Date.now() - started}ms`);
console.log(counts.join(" · "));
