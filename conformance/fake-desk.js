// pilo-desk's daemon as the conformance runs see it: a socket answering the server's
// requests from a world the scenario sets, no real pane ever typed into. Every
// request is kept, as [verb group, verb, pane, ...rest], for the scenario to read.
//
//   world: { agents: [{ pane_id, agent, cwd, agent_status, name, agent_session: { value } }],
//            screens: { <pane>: "screen text" },
//            fail: { <pane>: "error text for a prompt" } }
import { createServer } from "node:net";

const STATE = { working: "working", blocked: "waiting" };

export async function startDesk(sock) {
  let world = {};
  const calls = [];
  const sessions = () => (world.agents || []).map((a, i) => ({
    id: i + 1, name: a.name || "", program: a.agent || "", args: [], cwd: a.cwd || null, state: STATE[a.agent_status] || "idle",
    conversation: a.agent_session?.value || null, alive: true, seq: 0, pane: a.pane_id, gone: false
  }));
  const known = (pane) => (world.agents || []).some((a) => a.pane_id === pane);
  const answer = (r) => {
    switch (r.op) {
      case "list": return { ev: "sessions", list: sessions(), focus: null };
      case "read": calls.push(["pane", "read", r.pane]); return { ev: "text", text: world.screens?.[r.pane] || "" };
      case "prompt":
        calls.push(["agent", "prompt", r.pane, r.text]);
        if (world.fail?.[r.pane]) return { ev: "error", msg: world.fail[r.pane] };
        return known(r.pane) ? { ev: "done" } : { ev: "error", msg: `pane not found: ${r.pane}` };
      case "keys": calls.push(["agent", "send-keys", r.pane, ...r.keys]); return { ev: "done" };
      case "focus": calls.push(["agent", "focus", r.pane]); return { ev: "done" };
      case "start": calls.push(["agent", "start", r.name, r.program, r.pane, ...r.args]); return { ev: "spawned", id: 99 };
      default: return { ev: "error", msg: `fake desk: unknown ${r.op}` };
    }
  };
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let r; try { r = JSON.parse(line); } catch { r = {}; }
        c.write(JSON.stringify(answer(r)) + "\n");
      }
    });
    c.on("error", () => {});
  });
  await new Promise((res) => server.listen(sock, res));
  return { setWorld: (w) => { world = w; }, calls: () => calls, close: () => new Promise((res) => server.close(res)) };
}
