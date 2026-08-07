# Handoff

## 2026-08-07

Phase 1 dashboard/TUI/watcher implemented end to end. Task #165.

### Added

- `design/Pilo.dc.html`, `design/support.js` — design reference moved out of `public/`, chmod 444
- `migrations/002_schema.sql` — 8 tables, prototype tables renamed to `*_legacy_001`
- `src/db.js`, `src/api.js`, `src/herdr.js`, `src/watcher.js`, `src/paths.js`
- `public/fonts/` — IBM Plex Mono/Sans woff2 400/500/600
- `docs/ai/plans/2026-08-07-dashboard-implementation.md`

### Rewritten

- `src/server.js` — route table, port fallback, migrations on boot, watcher start
- `src/tui.js` — final_reply only, agent tree rail, setup screen, CJK column widths
- `public/dashboard.html` — 8 tabs on real data
- `bin/pilo` — `up | dashboard | status | doctor | stop | logs`, `~/.pilo` paths
- `README.md`

### Verified

- `bash -n bin/pilo`, `node --check` on every `src/*.js`
- migrations applied cleanly on the existing prototype database, legacy tables preserved
- API: agent/project CRUD, hierarchy rules, duplicate-pilo 409, delete guards (pilo, pm with children, project in use)
- Full flow through the API: inbox → task → pm_result + artifact → final_reply
- Watcher with a stubbed herdr: `요청 도착 #1` → `작업 도착 #1` → `결과 도착 #1`
- Wake failure path: `wake_failed` event + `herdr notification`, retry suppressed for 90s
- Dashboard in a real browser: every tab renders live data, settings writes persist, project create/delete through the UI
- Port fallback: second instance took 48889 and wrote it to its port file
- TUI: connected view and setup-required view

### Next

- Register the real `role='pilo'` agent and PM agents in the dashboard (the test rows were removed).
- Have PM agents report through `POST /api/tasks/:id/result` and the pilo agent through `POST /api/inbox/:id/reply`; write that into the agent rules (plan step 8).
- Retention deletion job (phase 2), pgvector embedding of kept records (phase 2).
- Korean glyphs fall back to system fonts; only the latin IBM Plex subset is bundled.
- `git push` and branch/PR handling are still pending user approval.
