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

The database is a container bound to `127.0.0.1:15432`. Its password is
generated on the first run and written to `~/.pilo/config.toml`; nothing
secret lives in this repository. `bin/pilo` reads it from there and hands
it to Docker Compose.

To supply your own instead, export both before the very first run —
PostgreSQL only applies the password when it initialises its volume:

```bash
export PILO_DB_PASSWORD='…'
export PILO_DATABASE_URL='postgres://pilo:…@127.0.0.1:15432/pilo'
```

Running `docker compose` by hand needs `PILO_DB_PASSWORD` set; without it
Compose stops and says so.

## Schedules

Work that should happen on its own clock. One row per standing job; each time one
comes due it opens an ordinary inbox row (and a task, unless the desk itself is
the target), so history and reporting are the ones that already exist.

```bash
pilo schedules                 # id · on/off · cadence · target · next run
pilo schedule 3 off            # stop it now; on to resume, rm to delete
pilo api POST /api/schedules '{"name":"아침 브리핑","toAgentId":"1",
  "cadence":"09:00","weekdaysOnly":true,"onMiss":"run","request":"..."}'
```

`cadence` is `HH:MM` in the server’s own timezone, or `every:N` minutes.
`onMiss` decides what happens to a slot the machine slept through: `run` takes it
late, `skip` drops it. A schedule whose last task is still open passes its slot
rather than stacking a second run, and three failures in a row switch it off.
`:schedules` shows the same list inside the TUI.

## Terminal

The tree writes what each agent runs in front of its name. Three tiers, and only
the last is guaranteed:

| Tier | When | Looks like |
| --- | --- | --- |
| icon | `PILO_ICONS=on` and an icon font with Nerd Fonts 3.5.0 or newer | ` pilo` |
| small caps | the default | `ᴄʟᴅ pilo` |
| capitals | `--ascii` or `NO_COLOR` | `CLD pilo` |

Icons stay opt-in because no terminal can be asked whether the font in use has
the glyph — a missing one draws a blank box, and a label never does.

An unrecognised runtime wears its own first three letters. `PILO_AMBIGUOUS_WIDTH`
forces the East Asian ambiguous width when the startup probe cannot run.

## Design Contract

The dashboard and TUI must match `design/Pilo.dc.html`.

Do not redesign during implementation. If exact reproduction is blocked, update the design file first.
