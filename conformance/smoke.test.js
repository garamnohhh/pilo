import test from "node:test";
import assert from "node:assert/strict";
import { startServer, folder } from "./harness.js";

test("a queued request wakes the desk agent once, a task wakes its PM", async () => {
  const srv = await startServer();
  try {
    const deskCwd = folder(srv, "desk"), pmCwd = folder(srv, "pm");
    srv.world({ agents: [
      { pane_id: "w1:p1", agent: "claude", cwd: deskCwd, agent_status: "idle" },
      { pane_id: "w1:p2", agent: "claude", cwd: pmCwd, agent_status: "idle" }
    ] });
    const desk = await srv.api("POST", "/api/agents", { name: "desk", role: "pilo", cwd: deskCwd, runtime: "claude" });
    assert.equal(desk.status, 201, desk.text);
    const pm = await srv.api("POST", "/api/agents", { name: "pm1", role: "pm", parentAgentId: desk.json.id, cwd: pmCwd, runtime: "claude", project: "p1" });
    assert.equal(pm.status, 201, pm.text);

    const inbox = await srv.api("POST", "/api/inbox", { userRequest: "hello" });
    assert.equal(inbox.status, 201, inbox.text);
    await srv.waitFor(() => srv.prompts("w1:p1").length, { what: "desk wake" });

    const task = await srv.api("POST", `/api/inbox/${inbox.json.id}/tasks`, { toAgentId: pm.json.id, request: "do it" });
    assert.equal(task.status, 201, task.text);
    await srv.waitFor(() => srv.prompts("w1:p2").some((m) => m.includes(`#${task.json.id}`)), { what: "pm wake" });
  } finally {
    await srv.stop();
  }
});
