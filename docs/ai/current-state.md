# Current State

Phase 1 is implemented against PostgreSQL. The prototype (`main` agent, tab-split psql calls, static dashboard) is gone.

## Product

- `pilo` starts postgres, applies migrations, starts the server + watcher, then enters the TUI.
- The user talks to the `role='pilo'` agent. The TUI shows `final_reply` only; there is no `pm_result` fallback.
- Work flows `inbox → task → pm_result → final_reply`, and the watcher wakes each agent through `herdr agent prompt`.
- The dashboard covers Overview, Agents, Inbox, Events, Artifacts, Projects, Settings, System — every screen reads and writes the real API.

## Layout

| Path | Role |
| --- | --- |
| `design/Pilo.dc.html`, `design/support.js` | design reference, read-only, not served |
| `public/dashboard.html` | the shipped dashboard |
| `public/fonts/` | IBM Plex Mono/Sans woff2 (400/500/600), latin subset |
| `src/server.js` | HTTP API + static files, port fallback, migration on boot |
| `src/api.js` | all endpoint logic |
| `src/db.js` | pg pool + migration runner (`schema_migrations`) |
| `src/herdr.js` | `herdr agent list` parsing, cwd matching, prompt, notification |
| `src/watcher.js` | inbox/task/result poll loop |
| `src/tui.js` | terminal UI |
| `src/paths.js` | `~/.pilo` config, port file, logs |
| `migrations/001_init.sql` | prototype schema, recorded as applied, never replayed |
| `migrations/002_schema.sql` | phase-1 schema |

## Database

`projects`, `agents`, `inbox`, `tasks`, `final_replies`, `events`, `artifacts`, `settings`, `schema_migrations`.

- `agents.role` is `pilo | pm | worker`; a partial unique index keeps exactly one live `pilo`.
- Hierarchy is `parent_agent_id` only: pm hangs off pilo, worker hangs off pm. The API rejects anything else.
- Agents and projects use soft delete (`archived_at`); past tasks keep their references.
- `agents.model` is a manual memo. Pilo cannot change the model of a running session.
- Prototype tables are preserved as `agents_legacy_001`, `tasks_legacy_001`, `events_legacy_001`.

## Runtime

- Server: `127.0.0.1:48888`, falls back to the next free port, writes the live port to `~/.pilo/port`.
- Dashboard is served by the same server at `/dashboard`. There is no second port.
- Postgres: Docker Compose, host port 15432, pgvector enabled.
- herdr has no port. `herdr agent list` supplies runtime (`codex`/`claude`), status, cwd and `pane_id`; agents bind by cwd match.
- Wake failures are recorded as `wake_failed` events and pushed through `herdr notification show`. A failed wake blocks retries for 90 seconds.

## Not implemented yet

- Retention deletion. Settings store the values; nothing is deleted (decision 2026-08-07).
- pgvector search. The extension is on, no embeddings are written.
- agent-bus → PostgreSQL migration.
