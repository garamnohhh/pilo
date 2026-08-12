import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const home = join(process.env.PILO_HOME || homedir(), ".pilo");
export const configFile = join(home, "config.toml");
export const portFile = join(home, "port");
export const pidFile = join(home, "server.pid");
export const logDir = join(home, "logs");
// The socket lives in the temp dir on purpose: agent sandboxes usually allow writes
// there, and connecting to a unix socket needs write permission on the socket file.
export const socketPath = process.env.PILO_SOCKET || join(tmpdir(), "pilo.sock");
export const socketFile = join(home, "socket");
export const logFile = join(logDir, "pilo.log");

// The database password is generated on the machine that runs Pilo and kept in
// ~/.pilo/config.toml, never in the repository. The container is created with it
// on the first run, so the two always match.
const newConfig = () => `# Pilo config
port = 48888
database_url = "postgres://pilo:${randomBytes(18).toString("base64url")}@127.0.0.1:15432/pilo"
`;

export function ensureHome() {
  mkdirSync(logDir, { recursive: true });
  if (!existsSync(configFile)) writeFileSync(configFile, newConfig(), { mode: 0o600 });
  return home;
}

function configValue(key) {
  try {
    const hit = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\n]+)"?`, "m").exec(readFileSync(configFile, "utf8"));
    return hit ? hit[1].trim() : "";
  } catch {
    return "";
  }
}

// Environment first, then the generated config. Nothing is hard-coded, so a
// checkout with neither says so instead of guessing a password.
export function databaseUrl() {
  const url = process.env.PILO_DATABASE_URL || configValue("database_url");
  if (url) return url;
  throw new Error(
    "database url not configured — run bin/pilo (writes ~/.pilo/config.toml) or set PILO_DATABASE_URL"
  );
}

export function dbPassword() {
  ensureHome();
  const hit = /^postgres(?:ql)?:\/\/[^:]+:([^@]+)@/.exec(databaseUrl());
  if (!hit) throw new Error("database url has no password — set PILO_DB_PASSWORD or fix ~/.pilo/config.toml");
  return decodeURIComponent(hit[1]);
}

// Never print the password back at the user.
export const maskUrl = (url) => String(url).replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/, "$1•••@");

export function writePort(port) {
  ensureHome();
  writeFileSync(portFile, String(port));
  return port;
}

export function writeSocket(path) {
  ensureHome();
  writeFileSync(socketFile, path);
  return path;
}

export function writePid(pid) {
  ensureHome();
  writeFileSync(pidFile, String(pid));
  return pid;
}

export function readPort() {
  try {
    return Number(readFileSync(portFile, "utf8").trim()) || Number(process.env.PILO_PORT || 48888);
  } catch {
    return Number(process.env.PILO_PORT || 48888);
  }
}

const safeUrl = () => {
  try {
    return databaseUrl();
  } catch {
    return "설정 안 됨 — bin/pilo 실행 또는 PILO_DATABASE_URL";
  }
};

export function paths() {
  return [
    { label: "config", value: configFile, note: "toml" },
    { label: "db", value: maskUrl(safeUrl()), note: "postgres + pgvector" },
    { label: "port", value: portFile, note: "실행 포트 기록" },
    { label: "socket", value: socketPath, note: "agent CLI 경로" },
    { label: "logs", value: logDir + "/", note: "dir" }
  ];
}
