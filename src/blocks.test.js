import test from "node:test";
import assert from "node:assert/strict";
import { claudeState, codexState, scan, of, reset, WORDS } from "./blocks.js";

const J = (o) => JSON.stringify(o);
const prompt = J({ type: "user", message: { content: "[pilo:inbox] request #4670" } });
const loginErr = J({ type: "assistant", isApiErrorMessage: true, error: "authentication_failed", message: { content: [{ type: "text", text: "Login expired · Please run /login" }] } });
const fine = J({ type: "assistant", message: { content: [{ type: "text", text: "아침 브리핑과 쌓인 요청 처리 중." }] } });
const tool = J({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });

test("the 11/2 transcript reads as a lost login, and a normal turn clears it", () => {
  assert.equal(claudeState([prompt, loginErr]).state, "login");
  assert.equal(claudeState([prompt, loginErr, prompt, fine]), null);
  // a prompt after the error with no answer yet: still the error's until something is written
  assert.equal(claudeState([prompt, loginErr, tool]).state, "login");
  assert.equal(claudeState([prompt, J({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", message: { content: "You've hit your limit" } })]), null);
  assert.equal(claudeState([prompt, J({ type: "assistant", isApiErrorMessage: true, error: "unknown", message: { content: "API Error: Connection error." } })]).state, "apierror");
  assert.equal(claudeState(["not json", ""]), null);
});

test("one session answering after the login came back clears it for every Claude session", () => {
  reset();
  const at = (t, o) => J({ ...JSON.parse(o), timestamp: t });
  // 11/2: the desk logged in again and answered at 09:11:55; handy's last word is still its 09:10 error
  const files = { d: [prompt, at("2026-11-02T00:00:02Z", loginErr)], h: [prompt, at("2026-11-02T00:10:02Z", loginErr)] };
  const agents = [{ id: 1, name: "pilo", runtime: "claude", cwd: "d" }, { id: 2, name: "handy", runtime: "claude", cwd: "h" }];
  const go = (t) => scan(agents, Date.parse(t), (f) => files[f], () => 0, (cwd) => cwd);
  assert.deepEqual(go("2026-11-02T00:10:30Z").map((c) => [c.name, c.state]), [["pilo", "login"], ["handy", "login"]]);
  files.d.push(prompt, at("2026-11-02T00:11:55Z", fine));
  assert.deepEqual(go("2026-11-02T00:12:10Z").map((c) => [c.name, c.cleared]), [["pilo", true], ["handy", true]]);
  // a Codex login is its own account
  assert.equal(codexState([J({ type: "event_msg", payload: { type: "error", message: "401 Unauthorized" } })]).state, "login");
});

test("codex: an error after its turn began", () => {
  const ev = (type, extra = {}) => J({ type: "event_msg", payload: { type, ...extra } });
  assert.equal(codexState([ev("task_started"), ev("error", { message: "unexpected status 401 Unauthorized" })]).state, "login");
  assert.equal(codexState([ev("task_started"), ev("error", { message: "stream disconnected" }), ev("task_complete")]), null);
  assert.equal(codexState([ev("task_started"), ev("error", { message: "stream disconnected before completion" })]).state, "apierror");
});

test("scan: told once, held while it lasts, cleared after; silence after a wake", () => {
  reset();
  const files = { a: [prompt, loginErr], b: [prompt, fine] };
  const read = (f) => files[f.split("/").pop().replace(".jsonl", "")] || [];
  const agents = [{ id: 1, name: "pilo", runtime: "codex", file: "/x/a.jsonl" }];
  // codex reading a Claude line finds nothing: the runtime picks the reader
  assert.deepEqual(scan(agents, 0, read, () => 0), []);
  const claudeAgent = { id: 2, name: "handy", runtime: "codex", file: "/x/b.jsonl", busy: true, wokeAt: 1000 };
  assert.equal(scan([claudeAgent], 1000 + 6 * 60000, read, () => 500)[0].state, "noanswer");
  assert.equal(of(2).state, "noanswer");
  assert.deepEqual(scan([claudeAgent], 1000 + 7 * 60000, read, () => 500), [], "the same, not told again");
  assert.equal(scan([claudeAgent], 1000 + 8 * 60000, read, () => 9e9)[0].cleared, true, "written since: answering again");
  assert.equal(of(2), null);
  assert.match(WORDS.login("claude"), /Claude 로그인 풀림 - 세션에서 \/login/);
});
