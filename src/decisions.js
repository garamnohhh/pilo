// What still waits on the user. The screens pin these under the conversation, so
// the rule for which ones show has to be the same in both, and has to let go of
// one the moment it is answered: a server that answers this question still sends
// nothing about answered ones, and an older one's list of them is ignored here.
export function waitingDecisions(overview) {
  const rows = overview?.decisions || [];
  return rows
    .filter((d) => d && d.taskId && d.open !== false && !d.answeredAt)
    .slice()
    .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
}
