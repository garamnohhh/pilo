// The dump both sides read and write: JSON lines. The first line names every
// table's columns and their kind; each line after it is one row as Postgres's
// row_to_json gives it (times as ISO strings, jsonb as JSON, booleans as such).
//
//   {"pilo_dump":1,"columns":{"agents":{"id":"int","created_at":"time",...},...}}
//   {"t":"agents","r":{"id":1,"name":"desk",...}}
export const TABLES = ["projects", "agents", "agent_sessions", "inbox", "tasks", "asks", "artifacts", "events", "final_replies", "schedules", "settings"];
export const KEY = { agent_sessions: "agent_id", settings: "key" };
export const kind = (pgType) => (/^timestamp/.test(pgType) ? "time" : pgType === "jsonb" || pgType === "json" ? "json"
  : pgType === "boolean" ? "bool" : /int|numeric|double|real/.test(pgType) ? "int" : "text");
