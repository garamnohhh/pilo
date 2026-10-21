// What the desk has waiting and why it has not been told yet. The watcher writes
// it each tick; the API reads it so a request can say "desk waiting" instead of
// looking stalled. Memory only: a restart starts empty and the next tick refills it.
export const deskWait = { reason: null, since: null, inboxIds: [] };
