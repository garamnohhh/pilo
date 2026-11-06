import test from "node:test";
import assert from "node:assert/strict";
import { relayEvents, relayRequest } from "./relaywatch.js";

test("the pager's event lines are the messages; its other lines are not", () => {
  const log = `[pager agent-noh] connected -> https://example/api/sse (part=agent-noh)
[pager agent-noh] event: "호반 챗봇 AWS 운영 이전 · WAF 예외 공유" from infra-gb10
[pager agent-noh] nudge deferred: tmux delivery failed (retry #1 in 500ms)
[pager agent-noh] event: "다시 "따옴표" 제목" from infra-gb10
`;
  assert.deepEqual(relayEvents(log), [
    { subject: "호반 챗봇 AWS 운영 이전 · WAF 예외 공유", from: "infra-gb10" },
    { subject: `다시 "따옴표" 제목`, from: "infra-gb10" }
  ]);
  assert.deepEqual(relayEvents("[pager x] skip nudge: no active wake\n"), []);
  // #5689: RelayRoom's own notices and what the part sent itself are not news
  assert.deepEqual(relayEvents(`[pager agent-noh] event: "스레드 열림" from system\n[pager agent-noh] event: "내가 보낸 것" from agent-noh\n`), []);
});

test("the task names the message and says what to do with it", () => {
  const r = relayRequest("제목", "infra-gb10");
  assert.match(r, /"제목" · 보낸 쪽 infra-gb10/);
  assert.match(r, /pilo done/);
});
