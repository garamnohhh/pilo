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
// PGlite keeps a real Postgres data directory on disk. One instance owns it at a
// time, and the lock beside it is what says which.
export const dataDir = () => process.env.PILO_DATA || join(home, "data");
export const lockFile = () => join(home, "db.lock");
export const logFile = join(logDir, "pilo.log");

// The database password is generated on the machine that runs Pilo and kept in
// ~/.pilo/config.toml, never in the repository. The container is created with it
// on the first run, so the two always match.
const newConfig = () => `# Pilo config
port = 48888
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
    { label: "db", value: dataDir() + "/", note: "PGlite (postgres + pgvector), 파일" },
    { label: "port", value: portFile, note: "실행 포트 기록" },
    { label: "socket", value: socketPath, note: "agent CLI 경로" },
    { label: "logs", value: logDir + "/", note: "dir" }
  ];
}
