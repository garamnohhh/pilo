# 2026-08-07 Dashboard Implementation

Goal: replace the prototype with the confirmed design. Every dashboard page, button and number is backed by the API and PostgreSQL.

## Steps

- [x] 1. Split design reference from implementation
  - `design/Pilo.dc.html`, `design/support.js` (reference, read-only)
  - `public/dashboard.html` stays the implementation target
  - update `README.md`
- [x] 2. `migrations/002_schema.sql`
  - new tables: `projects`, `agents`, `inbox`, `tasks`, `final_replies`, `events`, `artifacts`, `settings`
  - `agents.role` CHECK `pilo|pm|worker`, partial unique index on `role='pilo'`
  - `parent_agent_id`, `project_id` FK, `runtime`, `herdr_target`, `cwd`, `aliases`, `specialty`, `note`, `model` (display only), `archived_at`
  - prototype tables renamed to `*_legacy_001` instead of dropped
  - `schema_migrations` table so migrations run once
- [x] 3. `src/herdr.js`
  - parse `herdr agent list` JSON
  - match sessions by cwd, auto-fill `runtime` + `pane_id`
  - more than one candidate: return all, dashboard picks
  - `prompt(target, message)` for wake
- [x] 4. `src/db.js` + `src/server.js` API
  - agents CRUD + tree + rebind + wake
  - projects CRUD
  - inbox (list, detail trace, create), tasks, final_replies, events, artifacts
  - system status, settings read/write
- [x] 5. `public/dashboard.html`
  - Overview, Agents, Inbox, Events, Artifacts, Projects, Settings, System
  - real fetches, no dummy data, no dead buttons
- [x] 6. `src/tui.js`
  - `role='pilo'` agent as the counterpart, `final_reply` only, no `pm_result` fallback
  - agent tree rail with empty state, setup steps, `:dash` `:agents` `:inbox` `:help` `:cost`
- [x] 7. Port and paths
  - default 48888, fall back when busy, write the live port to `~/.pilo/port`
  - `~/.pilo/config.toml`, `~/.pilo/logs/`
- [x] 8. Watcher
  - `inbox` → wake pilo agent → task → wake pm/worker → `pm_result` → `final_reply`
  - `wake_failed` event plus `herdr notification show`
- [x] 9. Fonts
  - IBM Plex Mono/Sans woff2 (400/500/600) into `public/fonts/`
- [x] 10. Smoke test + docs
  - `docs/ai/current-state.md`, `decisions.md`, `handoff.md`

## Notes

- Retention settings are stored but nothing is deleted in phase 1 (decision 2026-08-07).
- `model` is a manual memo; Pilo cannot change the model of a running session.
- Token totals come from PM-reported values, counted per day.

All steps done 2026-08-07. Retention deletion stays in phase 2 by decision; fonts ship latin subset only.
