// Who may hang off whom, and which task a worker's task belongs to.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer, team, folder } from "./harness.js";

test("hierarchy and parent task rules", async () => {
  const srv = await startServer();
  try {
    const t = await team(srv);
    const post = (body) => srv.api("POST", "/api/agents", { runtime: "claude", cwd: folder(srv, body.name), ...body });

    assert.deepEqual([(await post({ name: "d2", role: "pilo" })).status], [409], "one desk");
    assert.equal((await post({ name: "p0", role: "pm" })).json.error, "pm agent needs a parent");
    assert.equal((await post({ name: "p2", role: "pm", parentAgentId: t.ids.pm })).json.error, "pm must hang off the pilo agent");
    assert.equal((await post({ name: "w2", role: "worker", parentAgentId: t.ids.desk })).json.error, "a worker hangs off a PM");
    assert.equal((await post({ name: "w3", role: "worker", parentAgentId: t.ids.worker })).json.error, "a worker hangs off a PM");

    const inbox = async (text) => (await srv.api("POST", "/api/inbox", { userRequest: text })).json.id;
    const send = (inboxId, toAgentId) => srv.api("POST", `/api/inbox/${inboxId}/tasks`, { toAgentId, request: "x" });

    // the worker's task hangs off its PM's open task on the same request
    const i1 = await inbox("one");
    const pmTask = (await send(i1, t.ids.pm)).json.id;
    const w1 = await send(i1, t.ids.worker);
    assert.equal(w1.status, 201, w1.text);
    assert.equal(w1.json.parentTaskId, String(pmTask));
    assert.equal(w1.json.corrected, undefined);

    // a wrong request number with one open PM task is corrected to that task's request
    const i2 = await inbox("two");
    const w2 = await send(i2, t.ids.worker);
    assert.equal(w2.json.parentTaskId, String(pmTask));
    assert.deepEqual(w2.json.corrected, { from: Number(i2), to: Number(i1) });
    assert.equal(w2.json.inboxId, String(i1));

    // two open PM tasks elsewhere: refused, naming them
    const i3 = await inbox("three");
    await send(i3, t.ids.pm);
    const i4 = await inbox("four");
    const w4 = await send(i4, t.ids.worker);
    assert.equal(w4.status, 400);
    assert.match(w4.json.error, new RegExp(`^pm1 has no open task on in-${i4}\\. Open: `));

    // a system agent takes no work
    const sys = await post({ name: "sys", role: "system", parentAgentId: t.ids.desk });
    assert.equal(sys.status, 201, sys.text);
    assert.match((await send(i4, sys.json.id)).json.error, /is a system agent and takes no work/);
  } finally {
    await srv.stop();
  }
});
