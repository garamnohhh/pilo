# Pilo

Local agent desk. You talk to the Pilo agent, it hands work to PM agents, and only the final reply comes back to the terminal.

## Run

```bash
./bin/pilo            # start services, enter the TUI
./bin/pilo up         # start postgres + server only
./bin/pilo status     # service status
./bin/pilo doctor     # diagnostics
./bin/pilo dashboard  # open the web dashboard
```

Pilo expects a Docker-compatible runtime.

- Recommended: OrbStack
- Supported: Docker Desktop, Colima

The first run starts PostgreSQL with Docker Compose, enables `pgvector` and applies the migrations.

Agent sessions live in [herdr](https://github.com/) — Pilo detects them with `herdr agent list` and wakes them with `herdr agent prompt`.

## Layout

| Path | Role |
| --- | --- |
| `design/Pilo.dc.html`, `design/support.js` | Design reference. Read-only, never served. |
| `public/dashboard.html` | The dashboard that actually ships. |
| `src/server.js` | HTTP API + static serving |
| `src/tui.js` | Terminal UI |
| `src/watcher.js` | inbox → wake → pm_result → final_reply loop |
| `src/herdr.js` | herdr session detection and wake |
| `migrations/` | SQL migrations, applied in order |

State lives in `~/.pilo/` (`config.toml`, `port`, `logs/`).

## Design Contract

The dashboard and TUI must match `design/Pilo.dc.html`.

Do not redesign during implementation. If exact reproduction is blocked, update the design file first.
