import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, unlinkSync, chmodSync } from "node:fs";
import { extname, join, normalize } from "node:path";

import { migrate, root } from "./db.js";
import * as api from "./api.js";
import { buildRules } from "./rules.js";
import { ensureHome, writePort, writePid, writeSocket, readPort, socketPath } from "./paths.js";
import { startWatcher } from "./watcher.js";
import { startSpool } from "./spool.js";
import { changed, openStream, listening } from "./changes.js";
import { quotaReport } from "./quota.js";
import { saveUpload } from "./attachments.js";

const publicDir = join(root, "public");
const wanted = Number(process.env.PILO_PORT || 48888);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

function json(res, code, payload) {
  res.writeHead(code, { "content-type": types[".json"], "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

// A read that has not changed since the caller last saw it costs a tag, not the
// body. The browser revalidates by itself under no-cache; the TUI sends the tag
// it kept. A client that sends none gets the full answer as before.
function jsonRead(req, res, payload) {
  const body = JSON.stringify(payload);
  const tag = `W/"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`;
  const headers = { "content-type": types[".json"], "cache-control": "no-cache", etag: tag };
  if (req.headers["if-none-match"] === tag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const routes = [
  ["GET", /^\/health$/, async () => ({ ok: true, name: "Pilo", port: readPort(), streams: listening() })],
  // part=stats: the counts alone, which is all the TUI's status line reads
  ["GET", /^\/api\/overview$/, async (_m, _b, q) => (q.get("part") === "stats" ? (({ stats, decisions }) => ({ stats, decisions }))(await api.overview()) : api.overview())],
  ["GET", /^\/api\/replies$/, (_m, _b, q) => api.replyBodies(q.get("ids") || "")],
  ["GET", /^\/api\/system$/, () => api.systemStatus()],
  ["GET", /^\/api\/models$/, () => api.modelOverview()],
  ["POST", /^\/api\/models$/, (_m, body) => api.requestModels(body)],
  ["POST", /^\/api\/models\/tap$/, (_m, body) => api.modelTap(body.on)],
  ["DELETE", /^\/api\/models\/pending\/(\d+)$/, (m) => api.cancelModelChange(Number(m[1]))],
  ["POST", /^\/api\/models\/pin\/(\d+)$/, (m, body) => api.pinModel(Number(m[1]), body)],
  ["GET", /^\/api\/quota$/, () => quotaReport()],
  ["GET", /^\/api\/setup$/, () => api.setupState()],

  ["GET", /^\/api\/sessions$/, () => api.listSessions()],
  ["GET", /^\/api\/agents$/, () => api.listAgents()],
  ["GET", /^\/api\/agents\/tree$/, () => api.agentTree()],
  ["POST", /^\/api\/agents$/, (_m, body) => api.createAgent(body)],
  ["PATCH", /^\/api\/agents\/(\d+)$/, (m, body) => api.updateAgent(Number(m[1]), body)],
  ["DELETE", /^\/api\/agents\/(\d+)$/, (m) => api.archiveAgent(Number(m[1]))],
  ["POST", /^\/api\/agents\/(\d+)\/rebind$/, (m, body) => api.rebindAgent(Number(m[1]), body.target || "")],
  ["POST", /^\/api\/agents\/(\d+)\/dismiss-wake$/, (m) => api.dismissWakeFailures(Number(m[1]))],
  ["POST", /^\/api\/agents\/(\d+)\/wake$/, (m, body) => api.wakeAgent(Number(m[1]), body.message || "")],
  ["GET", /^\/api\/agents\/(\d+)\/rules$/, (m) => buildRules(Number(m[1]))],
  ["POST", /^\/api\/agents\/(\d+)\/rules$/, (m) => api.applyRules(Number(m[1]))],

  ["GET", /^\/api\/projects$/, () => api.listProjects()],
  ["POST", /^\/api\/projects$/, (_m, body) => api.createProject(body)],
  ["PATCH", /^\/api\/projects\/(\d+)$/, (m, body) => api.updateProject(Number(m[1]), body)],
  ["DELETE", /^\/api\/projects\/(\d+)$/, (m) => api.archiveProject(Number(m[1]))],

  ["GET", /^\/api\/inbox$/, (_m, _b, q) => api.listInbox(q.get("limit") || 50, q.get("before"), q.get("agent") || "", { replies: q.get("replies") !== "0" })],
  ["GET", /^\/api\/history$/, (_m, _b, q) => api.searchHistory({ q: q.get("q") || "", since: q.get("since") || null, agent: q.get("agent") || "", limit: q.get("limit") })],
  ["GET", /^\/api\/inbox\/count$/, (_m, _b, q) => api.countInbox(q.get("agent") || "")],
  ["POST", /^\/api\/inbox$/, (_m, body) => api.createInbox(body.userRequest || body.text || "", body.cwd || "")],
  ["POST", /^\/api\/notes$/, (_m, body) => api.createNote(body)],
  ["GET", /^\/api\/inbox\/(\d+)$/, (m) => api.inboxDetail(Number(m[1]))],
  ["POST", /^\/api\/inbox\/(\d+)\/tasks$/, (m, body) => api.createTask(Number(m[1]), body)],
  ["POST", /^\/api\/inbox\/(\d+)\/reply$/, (m, body) => api.saveFinalReply(Number(m[1]), body)],

  ["GET", /^\/api\/tasks$/, () => api.listTasks()],
  ["GET", /^\/api\/tasks\/(\d+)$/, (m) => api.taskDetail(Number(m[1]))],
  ["POST", /^\/api\/tasks\/(\d+)\/hold$/, (m, body) => api.holdTask(Number(m[1]), body.note || "")],
  ["POST", /^\/api\/tasks\/(\d+)\/resume$/, (m) => api.resumeTask(Number(m[1]))],
  ["POST", /^\/api\/agents\/(\d+)\/limited$/, (m, body) => api.setLimited(Number(m[1]), body.until || null)],
  ["POST", /^\/api\/tasks\/(\d+)\/ask$/, (m, body) => api.askUser(Number(m[1]), body.body || body.text || "")],
  ["POST", /^\/api\/tasks\/(\d+)\/answer$/, (m, body) => api.answerTask(Number(m[1]), body.body || body.answer || "")],
  ["GET", /^\/api\/blocked$/, () => api.blockedTasks()],
  ["POST", /^\/api\/tasks\/(\d+)\/progress$/, (m, body) => api.noteProgress(Number(m[1]), body.text || body.progress || "")],
  ["POST", /^\/api\/tasks\/(\d+)\/result$/, (m, body) => api.saveTaskResult(Number(m[1]), body)],

  ["GET", /^\/api\/events$/, () => api.listEvents()],
  ["GET", /^\/api\/events\/(\d+)$/, (m) => api.eventDetail(Number(m[1]))],

  ["GET", /^\/api\/artifacts$/, () => api.listArtifacts()],
  ["GET", /^\/api\/artifacts\/(\d+)$/, (m) => api.artifactDetail(Number(m[1]))],

  ["GET", /^\/api\/schedules$/, () => api.listSchedules()],
  ["POST", /^\/api\/schedules$/, (_m, body) => api.createSchedule(body)],
  ["GET", /^\/api\/schedules\/(\d+)\/runs$/, (m) => api.scheduleRuns(Number(m[1]))],
  ["POST", /^\/api\/schedules\/(\d+)$/, (m, body) => api.setSchedule(Number(m[1]), body)],
  ["DELETE", /^\/api\/schedules\/(\d+)$/, (m) => api.deleteSchedule(Number(m[1]))],

  ["GET", /^\/api\/settings$/, () => api.settingsAll()],
  ["PUT", /^\/api\/settings\/([a-z]+)$/, (m, body) => api.saveSetting(m[1], body.value)]
];

// Two modules the dashboard imports directly; everything else under src stays put.
// The dashboard reads these straight from src, so the two never disagree.
const SHARED_MODULES = new Set(["/markdown.js", "/width.js", "/commands.js", "/text.js"]);

async function serveStatic(res, pathname, headOnly = false) {
  if (SHARED_MODULES.has(pathname)) {
    res.writeHead(200, { "content-type": types[".js"], "cache-control": "no-store" });
    res.end(headOnly ? undefined : await readFile(join(root, "src", pathname.slice(1))));
    return;
  }
  let path = pathname === "/" || pathname === "/dashboard" ? "/dashboard.html" : pathname;
  path = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const file = join(publicDir, path);
  if (!file.startsWith(publicDir) || !existsSync(file)) {
    json(res, 404, { error: "not found" });
    return;
  }
  const ext = extname(file);
  res.writeHead(200, {
    "content-type": types[ext] || "application/octet-stream",
    "cache-control": ext === ".woff2" || ext === ".png" ? "public, max-age=604800" : "no-store"
  });
  res.end(headOnly ? undefined : await readFile(file));
}

// One place that maps method+path+body to a result, shared by HTTP, the unix
// socket and the file spool.
export async function dispatch(method, pathname, body = {}, query = new URLSearchParams()) {
  // The socket and the file spool hand over a whole path, query string and all;
  // the HTTP server has already split it. Take either.
  const cut = String(pathname).indexOf("?");
  const path = cut === -1 ? String(pathname) : String(pathname).slice(0, cut);
  const params = cut === -1 ? query : new URLSearchParams(String(pathname).slice(cut + 1));
  for (const [routeMethod, pattern, run] of routes) {
    if (routeMethod !== method) continue;
    const match = pattern.exec(path);
    if (!match) continue;
    const payload = (await run(match, body, params)) ?? { ok: true };
    // Every write, from the dashboard, the CLI's socket or the spool, passes here.
    if (method !== "GET") changed();
    return { status: method === "POST" ? 201 : 200, payload };
  }
  return null;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  if (method === "GET" && url.pathname === "/api/stream") {
    openStream(req, res);
    return;
  }
  // An image from the dashboard: raw bytes, not JSON, so it is read before the
  // JSON body parser would try.
  if (method === "POST" && url.pathname === "/api/attachments") {
    json(res, 201, await saveUpload(req));
    return;
  }
  const known = routes.some(([m, pattern]) => m === method && pattern.test(url.pathname));
  if (known) {
    const body = method === "GET" || method === "DELETE" ? {} : await readBody(req);
    const result = await dispatch(method, url.pathname, body, url.searchParams);
    if (method === "GET" && result.status === 200) jsonRead(req, res, result.payload);
    else json(res, result.status, result.payload);
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(res, url.pathname, req.method === "HEAD");
    return;
  }
  json(res, 404, { error: "not found" });
}

function listen(server, port, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
        server.removeListener("error", onError);
        resolve(listen(server, port + 1, attemptsLeft - 1));
      } else {
        reject(err);
      }
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve(port);
    });
  });
}

// Two servers on one database means two watchers waking the same sessions.
const running = await fetch(`http://127.0.0.1:${readPort()}/health`)
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
if (running?.name === "Pilo") {
  console.log(`Pilo is already running on port ${running.port}`);
  process.exit(0);
}

const ran = await migrate();
if (ran.length) console.log(`migrations applied: ${ran.join(", ")}`);
ensureHome();

const server = createServer((req, res) => {
  handle(req, res).catch((err) => json(res, err.status || 500, { error: err.message }));
});

const port = await listen(server, wanted, 20);
writePort(port);
writePid(process.pid);

// Same API over a unix socket. Agents run inside sandboxes that block TCP, and a
// socket is a file, so `pilo` subcommands keep working with network access off.
const socketServer = createServer((req, res) => {
  handle(req, res).catch((err) => json(res, err.status || 500, { error: err.message }));
});
try {
  if (existsSync(socketPath)) unlinkSync(socketPath);
  await new Promise((resolve, reject) => {
    socketServer.once("error", reject);
    socketServer.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  writeSocket(socketPath);
  process.on("exit", () => {
    try {
      unlinkSync(socketPath);
    } catch {}
  });
} catch (err) {
  console.error(`socket unavailable (${err.message}); TCP only`);
}

startSpool(dispatch);
startWatcher();
console.log(`Pilo listening on http://127.0.0.1:${port} and ${socketPath}`);
