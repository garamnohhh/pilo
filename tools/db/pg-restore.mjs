// Dump -> a NEW PGlite data folder, schema from the migrations: the way back
// from SQLite. Refuses a folder that already has anything in it.
//   node tools/db/pg-restore.mjs <dump.jsonl> <new data dir>
import { createReadStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { TABLES, KEY } from "./common.mjs";

const [dumpFile, dir] = process.argv.slice(2);
if (!dumpFile || !dir) { console.error("usage: pg-restore.mjs <dump.jsonl> <new data dir>"); process.exit(2); }
if (existsSync(dir) && readdirSync(dir).length) { console.error(`${dir} is not empty`); process.exit(1); }
process.env.PILO_DATA = dir;
process.env.PILO_HOME ||= dir + "-home";
mkdirSync(process.env.PILO_HOME + "/.pilo", { recursive: true });
const { query, migrate, open } = await import("../../src/db.js");
await migrate();
const db = await open();
await db.exec("SET TIME ZONE 'UTC'");
let columns = null;
const counts = Object.fromEntries(TABLES.map((t) => [t, 0]));
await db.exec("BEGIN; SET CONSTRAINTS ALL DEFERRED;");
// the triggers that guard foreign keys are off while rows go in out of order
await db.exec("SET session_replication_role = replica");
for (const t of TABLES) await db.exec(`DELETE FROM "${t}"`);   // what the migrations seeded (system schedules)
for await (const line of createInterface({ input: createReadStream(dumpFile) })) {
  if (!line) continue;
  const x = JSON.parse(line);
  if (x.pilo_dump) { columns = x.columns; continue; }
  const names = Object.keys(x.r);
  const vals = names.map((n) => (columns[x.t][n] === "json" ? JSON.stringify(x.r[n]) : x.r[n]));
  await db.query(`INSERT INTO "${x.t}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  counts[x.t]++;
}
await db.exec("SET session_replication_role = origin");
for (const t of TABLES) {
  if (KEY[t]) continue;
  await db.query(`SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), GREATEST((SELECT max(id) FROM "${t}"), 1), (SELECT max(id) FROM "${t}") IS NOT NULL)`);
}
await db.exec("COMMIT");
void query;
await db.close();
console.log(JSON.stringify(counts));
