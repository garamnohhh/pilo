// One word for what an agent is doing, walked once. The dot, the word beside it
// and the mark under the pointer all come out of the same rung, so two screens
// cannot say different things about the same agent — the tree read "idle" while
// the dashboard drew a red "!" on the same row, and before that the agents screen
// said "stalled" where the requests screen said "working".
//
// The dashboard keeps its own copy of this ladder inline: the page is served by
// whichever server is running, and an older one would 404 the import and take the
// whole page down. agentstate.test.js reads that copy and holds the two in step.
//
// Two signals feed it: the work Pilo handed out, and what herdr says the bound
// pane is doing. Ten minutes of silence from the work an agent holds, on a pane
// that is idle or finished, is the pair that means it stopped without reporting.
// Either one alone is normal — agents think for a long time between progress
// lines, and a busy pane may be the user typing into it.
export const STALL_MS = 10 * 60 * 1000;

export function stalled(agent, now = Date.now()) {
  if (agent.status !== "running" || !agent.lastSignal) return false;
  if (agent.sessionStatus === "working") return false;
  return now - new Date(agent.lastSignal).getTime() > STALL_MS;
}

export function agentState(agent, now = Date.now()) {
  if (agent.limitedUntil && new Date(agent.limitedUntil).getTime() > now) return "limited";
  // A give-up now only counts while the work it gave up on is still waiting, so
  // it outranks the "running" the queued task itself puts on the row: nobody is
  // nudging that agent any more, whatever the task table says it holds.
  if (agent.gaveUp > 0) return "gaveUp";
  if (agent.status === "running" && stalled(agent, now)) return "stalled";
  if (agent.status === "blocked") return "blocked";
  if (agent.status === "failed") return "failed";
  if (agent.status === "unbound") return "unbound";
  if (agent.status === "running" || agent.sessionStatus === "working") return "running";
  return "idle";
}
