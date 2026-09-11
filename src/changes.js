// The dashboard used to ask every five seconds whether anything had happened.
// Now whatever writes rings this bell, and every open stream hears one line.
// Writes come in bursts — a task result is a row, an event and a wake — so the
// rings inside one short window go out as a single notice.
const WINDOW_MS = Number(process.env.PILO_CHANGE_WINDOW_MS || 150);
const PING_MS = Number(process.env.PILO_STREAM_PING_MS || 20000);

const listeners = new Set();
let pending = null;

export function changed() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    for (const hear of listeners) hear();
  }, WINDOW_MS);
  pending.unref?.();
}

export function onChange(hear) {
  listeners.add(hear);
  return () => listeners.delete(hear);
}

// How many streams are open, for /health: a closed tab must not stay counted.
export const listening = () => listeners.size;

// Server-sent events. "changed" carries nothing — the page already knows how to
// load everything. The named ping is for the page's own clock: a connection left
// open across a laptop's sleep can look open and hear nothing, and a page that
// has not heard a ping in a while reconnects. The headers ask anything in
// between not to buffer or transform what goes through.
export function openStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  req.socket.setNoDelay?.(true);
  req.socket.setTimeout?.(0);
  res.write("retry: 3000\n\n");
  const off = onChange(() => res.write("data: changed\n\n"));
  const ping = setInterval(() => res.write("event: ping\ndata: .\n\n"), PING_MS);
  ping.unref?.();
  const close = () => {
    off();
    clearInterval(ping);
  };
  req.on("close", close);
  res.on("error", close);
}
