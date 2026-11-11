// PGlite data folder -> dump. Open a COPY: PGlite takes no lock of its own.
//   node tools/db/pg-dump.mjs <data dir> <out.jsonl>
import { createWriteStream } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { TABLES, KEY, kind } from "./common.mjs";

const [dir, outFile] = process.argv.slice(2);
if (!dir || !outFile) { console.error("usage: pg-dump.mjs <data dir> <out.jsonl>"); process.exit(2); }
const db = await PGlite.create({ dataDir: dir, extensions: { vector } });
await db.exec("SET TIME ZONE 'UTC'");
const columns = {};
for (const t of TABLES) {
  const cols = await db.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", [t]);
  columns[t] = Object.fromEntries(cols.rows.map((c) => [c.column_name, kind(c.data_type)]));
}
const out = createWriteStream(outFile);
out.write(JSON.stringify({ pilo_dump: 1, columns }) + "\n");
const counts = {};
for (const t of TABLES) {
  const rows = await db.query(`SELECT row_to_json(x)::text AS j FROM "${t}" x ORDER BY "${KEY[t] || "id"}"`);
  for (const { j } of rows.rows) out.write(`{"t":"${t}","r":${j}}\n`);
  counts[t] = rows.rows.length;
}
await new Promise((r) => out.end(r));
await db.close();
console.log(JSON.stringify(counts));
