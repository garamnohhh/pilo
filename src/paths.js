import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const home = join(process.env.PILO_HOME || homedir(), ".pilo");
export const configFile = join(home, "config.toml");
export const portFile = join(home, "port");
export const logDir = join(home, "logs");
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
    { label: "logs", value: logDir + "/", note: "dir" }
  ];
}
