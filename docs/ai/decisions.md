# Decisions

## 2026-08-05

- Product name: `Pilo`.
- CLI command: `pilo`.
- Pilo is built separately from the current `agent-bus`.
- Existing `agent-bus` will be used as behavior reference, not modified now.
- Pilo will implement its own PostgreSQL bus/wake/task flow.
- Existing `agent-bus` data will be migrated only after Pilo works.
- PostgreSQL is managed by Docker Compose.
- `pgvector` is enabled in phase 1; actual vector search is phase 2.
- UI must match the supplied design files.
- The user-facing representative agent is `role='pilo'`.
- `role='pilo'` is unique; Project agents are `role='pm'`.
- Pilo TUI shows `final_reply` only by default.
- `pm_result` and raw events are dashboard-only.
- Agent hierarchy is supported in phase 1 with `parent_agent_id`.
- PM agents may have backend/frontend/reviewer/custom child agents.
- Child agents report only to their parent.
- Cross-hierarchy collaboration is not allowed; Pilo agent creates cross-team tasks.
- Final user-facing reply is always written by the Pilo agent.

## 2026-08-07

- Design reference files are `public/Pilo.dc.html` and `public/support.js`; `public/dashboard.html` is the implementation target, not a design file.
- Fonts: IBM Plex Mono/Sans, packaged locally as woff2. No CDN.
- Port: default 48888 with fallback on conflict, actual port written to `~/.pilo/port`. Dashboard is served by the same server at `/dashboard`. No second port.
- herdr has no listening port; wake is a CLI call (`herdr agent prompt`).
- `herdr agent list` provides runtime (`codex`/`claude`), status, cwd and pane_id, so runtime and target are auto-detected by cwd match. Re-bind manually when a session is replaced.
- CLI set: `pilo up`, `pilo status`, `pilo doctor`. GUI first, CLI possible.
- Agent roles: `pilo`, `pm`, `worker`. Exactly one `pilo` enforced by a partial unique index.
- `model` is a display-only manual memo, not a value Pilo can enforce.
- `specialty` field added to agents.
- Projects become a real entity; `agents.project_id` references `projects`.
- Artifacts store path, delta and diff text only. No full file snapshots.
- Notifications reuse `herdr notification show`; dashboard badges stay as a secondary channel.
- Token totals are counted per day and come from PM-reported values in `pm_result`.
- Retention is split: system logs are deletable, work records are kept forever.
  - Deletable: events (30 days; failure events such as `wake_failed` 90 days), run log (14 days), server log (14 days).
  - Never deleted: inbox, task request, `pm_result`, `final_reply`, artifacts. These are the future embedding corpus.
  - Phase 1 stores the retention settings only; the delete job lands in phase 2 (on server start and once a day).
- Agents use soft delete (`archived_at`) so past task references stay intact.
- `aliases` is stored as comma-separated TEXT for now.
- One inbox row fans out to N tasks; worker branches hang off `parent_task_id`.
