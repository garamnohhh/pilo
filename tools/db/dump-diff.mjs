// Two dumps, table by table: row counts and a hash of each row, times compared
// to the microsecond and JSON with its keys in order. Exit 1 on any difference.
//   node tools/db/dump-diff.mjs <a.jsonl> <b.jsonl>
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const micros = (s) => {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/.exec(s);
  if (!m) return s;
  return String(BigInt(Date.parse(m[1] + m[3])) * 1000n + BigInt((m[2] || "").padEnd(6, "0") || 0));
};
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

async function read(file) {
  let columns = null;
  const tables = {};
  for await (const line of createInterface({ input: createReadStream(file) })) {
    if (!line) continue;
    const x = JSON.parse(line);
    if (x.pilo_dump) { columns = x.columns; continue; }
    const row = Object.fromEntries(Object.keys(x.r).sort().map((k) => {
      const v = x.r[k], kind = columns[x.t][k];
      return [k, v === null ? null : kind === "time" ? micros(v) : kind === "json" ? canon(v) : v];
    }));
    (tables[x.t] ||= []).push(createHash("sha256").update(JSON.stringify(row)).digest("hex"));
  }
  return tables;
}

const [a, b] = await Promise.all(process.argv.slice(2, 4).map(read));
let bad = 0;
for (const t of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
  const x = a[t] || [], y = b[t] || [];
  const ys = new Set(y), diff = x.filter((h) => !ys.has(h)).length;
  const ok = x.length === y.length && diff === 0;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "DIFF"} ${t.padEnd(15)} ${String(x.length).padStart(6)} ${String(y.length).padStart(6)}${diff ? `  ${diff} rows differ` : ""}`);
}
process.exit(bad ? 1 : 0);
