// The server is on localhost, so there is nothing worth caching aggressively.
// This worker exists to make the dashboard installable and to show an honest
// message when the Pilo server is not running.
const SHELL = "pilo-shell-v2";
const OFFLINE = `<!doctype html><meta charset="utf-8"><title>Pilo</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#08090a;color:#7d887f;
font:13px ui-monospace,Menlo,monospace}b{color:#eef2ee;font-weight:600;letter-spacing:-.03em;font-size:17px}</style>
<div style="text-align:center"><b>Pilo</b><p>서버가 꺼져 있습니다 — 터미널에서 <code>pilo up</code></p></div>`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(["/icons/app-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).catch(async () => {
      const hit = await caches.match(event.request);
      if (hit) return hit;
      if (event.request.mode === "navigate") {
        return new Response(OFFLINE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response(JSON.stringify({ error: "pilo server offline" }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    })
  );
});
