import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

const DEFAULT_CONFIG = `# Pilo config
port = 48888
database_url = "postgres://pilo:pilo@127.0.0.1:15432/pilo"
`;

export function ensureHome() {
  mkdirSync(logDir, { recursive: true });
  if (!existsSync(configFile)) writeFileSync(configFile, DEFAULT_CONFIG);
  return home;
}

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

export function paths() {
  return [
    { label: "config", value: configFile, note: "toml" },
    { label: "db", value: process.env.PILO_DATABASE_URL || "postgres://pilo@127.0.0.1:15432/pilo", note: "postgres + pgvector" },
    { label: "port", value: portFile, note: "실행 포트 기록" },
    { label: "socket", value: socketPath, note: "agent CLI 경로" },
    { label: "logs", value: logDir + "/", note: "dir" }
  ];
}
