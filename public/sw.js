// The page comes from the Mac. A phone opens it over Tailscale, and when the Mac
// is asleep or off there is nothing to answer, so the page itself has to be on
// the phone already: every page and file that loads is kept, and served from
// here when the network does not answer in time. The API is never served from
// here — a request either reaches the server or fails at once, so the page can
// say it is offline instead of showing old numbers as if they were live.
const SHELL = "pilo-shell-v3";
const WAIT_MS = 4000; // a Mac that sleeps does not refuse, it just never answers

// Only for a phone that has never had the page: the dashboard keeps its own
// offline screen once it has loaded once.
const OFFLINE = `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Pilo</title>
<style>
:root{--bg:#08090a;--surface:#0f1110;--line:#232826;--text:#eef2ee;--text-2:#a9b2ab;--text-3:#6f7a72;--err:#e5484d;--accent:#3ecf8e}
@media (prefers-color-scheme: light){:root{--bg:#f4f6f4;--surface:#fff;--line:#d6dbd7;--text:#141716;--text-2:#4b544e;--text-3:#7b857e;--err:#b5473a;--accent:#3ecf8e}}
html{-webkit-text-size-adjust:100%}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:15px/1.62 -apple-system,system-ui,sans-serif;display:flex;flex-direction:column}
.top{display:flex;align-items:center;gap:12px;min-height:48px;padding:env(safe-area-inset-top) 16px 0;border-bottom:1px solid var(--line);font:600 15px ui-monospace,Menlo,monospace;position:sticky;top:0;background-color:var(--bg)}
.top b{color:var(--accent)}.top i{font-style:normal;font-weight:400;font-size:13px;color:var(--err)}
main{flex:1;display:flex;flex-direction:column;gap:12px;padding:max(16px,14vh) 16px 16px;word-break:keep-all}
.rows{margin-top:10px;display:flex;flex-direction:column;gap:8px}code{font:13px ui-monospace,Menlo,monospace}
.box{background:var(--surface);border:1px solid var(--line);padding:24px}.chk{border:1px dashed var(--line);padding:16px 20px;color:var(--text-2);font-size:13px}
.lbl{font:11px ui-monospace,Menlo,monospace;letter-spacing:.14em;color:var(--text-3)}h1{margin:12px 0 0;font-size:22px;font-weight:400;line-height:1.3}
button{margin-top:20px;width:100%;height:44px;border:0;background:var(--accent);color:#08090a;font:600 15px system-ui}
</style>
<div class="top"><span><b>❯</b> pilo</span><i>■ offline</i></div>
<main><div class="box"><div class="lbl" style="color:var(--err)">NOT CONNECTED</div><h1>맥북에 연결할 수 없어요</h1>
<p style="margin:12px 0 0;color:var(--text-2)">Pilo는 맥북에서 돌아요. 맥북이 잠들었거나 같은 네트워크에 없으면 여기서 열 수 없어요.</p>
<button onclick="location.reload()">다시 시도</button></div>
<div class="chk"><div class="lbl">CHECK</div><div class="rows"><span>맥북이 켜져 있는지</span><span>폰과 맥북이 같은 Tailscale에 있는지</span><span>맥북에서 <code>pilo status</code></span></div></div></main>
<script>setTimeout(function(){location.reload()},15000)</script></html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(["/icons/app-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => event.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));

const late = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The network first, so a Mac that answers always gives the newest page; what
// came back is kept. No answer within WAIT_MS, or a refusal, and the kept copy
// is used — if there is one; with none, the network is all there is.
async function kept(request, key) {
  const cache = await caches.open(SHELL);
  // With the Pilo server stopped the Mac still answers: tailscale serve sends
  // a 502 with an empty body, which a phone draws as a blank white page. Any
  // 5xx counts as no answer.
  const net = fetch(request).then((res) => {
    if (res.status >= 500) throw new Error(`server answered ${res.status}`);
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  const copy = await cache.match(key);
  if (!copy) return net;
  return Promise.race([net, late(WAIT_MS).then(() => copy)]).catch(() => copy);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  // the event stream goes straight to the network: held open through a worker,
  // it kept the old worker busy and a new one waiting for good
  if (url.pathname === "/api/stream") return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
    // answered by the server or not at all, and not left hanging on a Mac that sleeps
    event.respondWith(Promise.race([fetch(event.request).then((res) => { if (res.status >= 500 && !res.headers.get("content-type")?.includes("json")) throw new Error("proxy"); return res; }),
      late(WAIT_MS * 2).then(() => { throw new Error("timeout"); })])
      .catch(() => new Response(JSON.stringify({ error: "pilo server offline" }), { status: 503, headers: { "content-type": "application/json" } })));
    return;
  }
  if (event.request.mode === "navigate") {
    event.respondWith(kept(event.request, url.pathname).catch(() => new Response(OFFLINE, { headers: { "content-type": "text/html; charset=utf-8" } })));
    return;
  }
  event.respondWith(kept(event.request, url.pathname + url.search).catch(() => new Response("", { status: 504 })));
});
