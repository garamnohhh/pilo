// pilo-usage — after each turn, and whenever a plan limit's percent changes,
// Claude Code measures the session. This writes that measure to a file in
// Pilo's home, which is where this directory lives (Pilo copies it to
// <home>/.pilo/mods/pilo-usage), so it reads no environment to find it.
//
// It reads nothing else: no conversation, no environment, no settings, and it
// sends nothing over the network. A failure is swallowed — the session never
// waits on Pilo.
export function register(on) {
  on('session.measure', async ($, e, next) => {
    try {
      const id = await $.session.id()
      const row = {
        session: id,
        cwd: await $.session.cwd(),
        model: await $.session.model(),
        at: Date.now(),
        context: e.context || null,
        rateLimits: e.rateLimits || [],
        cost: e.cost || null
      }
      // <home>/.pilo/mods/pilo-usage → <home>/.pilo/usage/<session>.json
      const dir = $.plugin.root.replace(/\/mods\/pilo-usage\/?$/, '')
      await $.fs.write(dir + '/usage/' + id.replace(/[^A-Za-z0-9_-]/g, '') + '.json', JSON.stringify(row))
    } catch {
      // nothing to do: the next turn writes again
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
