import test from "node:test";
import assert from "node:assert/strict";

import { pickResults, withResults } from "./reply.js";

const task = (over) => ({ status: "done", pmResult: "", error: "", agentId: 7, agent: "hoban", role: "pm", parentId: 1, parentRole: "pilo", ...over });

test("a worker under a PM on the same request is left to its PM", () => {
  const tasks = [
    task({ pmResult: "hoban's gathered report" }),
    task({ agentId: 2, agent: "chatbot", role: "worker", parentId: 7, parentRole: "pm", pmResult: "chatbot's own" })
  ];
  assert.deepEqual(pickResults(tasks).map((t) => t.agent), ["hoban"]);
});

test("a worker the desk owns, or one whose PM holds nothing here, is attached", () => {
  const tasks = [
    task({ agentId: 19, agent: "handy", role: "worker", parentId: 1, parentRole: "pilo", pmResult: "ran it" }),
    task({ agentId: 2, agent: "chatbot", role: "worker", parentId: 7, parentRole: "pm", pmResult: "alone" })
  ];
  assert.deepEqual(pickResults(tasks).map((t) => t.agent), ["handy", "chatbot"]);
});

test("unfinished tasks wait, and a task sent again replaces the first", () => {
  const tasks = [
    task({ pmResult: "late first attempt" }),
    task({ agentId: 6, agent: "pilo-dev", status: "running" }),
    task({ pmResult: "the retry" })
  ];
  const picked = pickResults(tasks);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].pmResult, "the retry");
});

test("one result sits under the lead with nothing between", () => {
  const body = withResults("고쳤음. 서버 재시작 필요", [task({ pmResult: "**결론**\n- 원인 A\n" })]);
  assert.equal(body, "고쳤음. 서버 재시작 필요\n\n---\n\n**결론**\n- 원인 A");
});

test("several results are named, and a failure says so with its reason", () => {
  const body = withResults("둘 다 끝남", [
    task({ pmResult: "A 끝" }),
    task({ agentId: 4, agent: "fitxel", status: "failed", error: "SESSION_NOT_FOUND", pmResult: "못 함" })
  ], "실패");
  assert.equal(body, "둘 다 끝남\n\n---\n\n**hoban**\n\nA 끝\n\n---\n\n**fitxel** · 실패\n\nSESSION_NOT_FOUND\n\n못 함");
});

test("no lead still saves the results", () => {
  assert.equal(withResults("", [task({ pmResult: "only this" })]), "only this");
});
