// windowOnly in Node and in Rust (`pilo hook classify`), on the same calls:
// every call src/approvals.test.js makes, plus tools/hook-corpus.jsonl. Exit 1
// on any call the two judge differently.
//   node tools/compare-hook.mjs [rust binary]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { windowOnly } from "../hooks/pilo-hook.mjs";
import { describe, plainAsk } from "../src/describe.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = process.argv[2] || join(repo, "rust/target/debug/pilo");
// the test file's calls: run it once with windowOnly writing down what it is asked
const seen = join(repo, "src", ".hook-calls.jsonl");
const shim = join(repo, "src", ".hook-corpus.test.js");
writeFileSync(seen, "");
const test = readFileSync(join(repo, "src/approvals.test.js"), "utf8")
  .replace(/A\.windowOnly\(/g, "__rec(")
  .replace(/^(import .*\n)+/m, (m) => `${m}import { appendFileSync as __a } from "node:fs";\nconst __rec = (tool, input) => { __a(${JSON.stringify(seen)}, JSON.stringify({ tool, input }) + "\\n"); return A.windowOnly(tool, input); };\n`);
writeFileSync(shim, test);
try { execFileSync(process.execPath, ["--test", shim], { cwd: repo, stdio: "ignore" }); } catch {}
rmSync(shim);
const calls = [...readFileSync(seen, "utf8").split("\n"), ...(existsSync(join(repo, "tools/hook-corpus.jsonl")) ? readFileSync(join(repo, "tools/hook-corpus.jsonl"), "utf8").split("\n") : [])]
  .filter(Boolean).map((l) => JSON.parse(l));
rmSync(seen);
const unique = [...new Map(calls.map((c) => [JSON.stringify(c), c])).values()];
const rust = execFileSync(bin, ["hook", "classify"], { input: unique.map((c) => JSON.stringify(c)).join("\n") + "\n" }).toString().trim().split("\n").map((l) => JSON.parse(l));
let bad = 0;
unique.forEach((c, i) => {
  const want = windowOnly(c.tool, c.input);
  if (want !== rust[i]) { bad++; console.log(`DIFF ${c.tool} ${JSON.stringify(c.input).slice(0, 160)}\n     node ${JSON.stringify(want)} rust ${JSON.stringify(rust[i])}`); }
});
// what the cards say about the same calls: describe's steps and the plain sentence
const menu = { options: [{ n: 1, label: "Yes" }, { n: 2, label: "Yes, and always allow x", standing: true }, { n: 3, label: "No, and tell Claude what to do differently" }] };
const items = unique.map((c, i) => ({ ...c, agent: ["pilo-dev", "hoban", "garamnoh"][i % 3], reason: windowOnly(c.tool, c.input) }));
const said = execFileSync(bin, ["hook", "describe"], { input: items.map((c) => JSON.stringify(c)).join("\n") + "\n" }).toString().trim().split("\n").map((l) => JSON.parse(l));
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((y) => [y, x[y]])) : x));
let badSaid = 0;
items.forEach((c, i) => {
  const want = { about: describe(c.tool, c.input), plain: plainAsk(c, menu) };
  if (canon(want) !== canon(said[i])) { badSaid++; if (badSaid <= 8) console.log(`DIFF card ${JSON.stringify(c.input).slice(0, 120)}\n     node ${canon(want).slice(0, 300)}\n     rust ${canon(said[i]).slice(0, 300)}`); }
});
bad += badSaid;
console.log(`${unique.length * 2 - bad}/${unique.length * 2} the same (rules and cards)`);
process.exit(bad ? 1 : 0);
