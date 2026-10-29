// What the desk has waiting and why it has not been told yet. The watcher writes
// it each tick; the API reads it so a request can say "desk waiting" instead of
// looking stalled. Memory only: a restart starts empty and the next tick refills it.
export const deskWait = { reason: null, since: null, inboxIds: [] };

// The hourly cap guards against results and follow-ups waking the desk over and
// over; a request the user sent themselves is never what it guards against
// (10/29: two requests sat behind the cap for six minutes). Over the cap, the
// user's own go now and the rest wait: they are found again on the next tick,
// every pump reads its work from the database, nothing is lost by waiting.
export function splitForCap(items, overCap) {
  if (!overCap) return { send: items, hold: [] };
  return { send: items.filter((x) => x.user), hold: items.filter((x) => !x.user) };
}
