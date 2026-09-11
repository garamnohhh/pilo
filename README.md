# Pilo

Local agent desk. You talk to one agent in a terminal; it hands the work to the
project agents you registered and brings back a single answer. Everything runs on
your own machine — Pilo opens no port to the outside and sends nothing anywhere.

## What you need

| | |
| --- | --- |
| Node.js 20 or newer | runs the server, the TUI and the CLI |
| [herdr](https://herdr.dev) | the terminal workspace Pilo watches — `brew install herdr` (Apache-2.0) |
| At least one coding agent | Claude Code or Codex, running in a herdr pane |

Pilo does not start your agents. You open them yourself in herdr panes; Pilo
finds them with `herdr agent list` and wakes them with `herdr agent prompt`.

## Run

```bash
./bin/pilo            # start services, enter the TUI
./bin/pilo up         # start the server only — it opens the database itself
./bin/pilo status     # service status
./bin/pilo doctor     # diagnostics
./bin/pilo dashboard  # open the web dashboard
```

The first run creates the database under `~/.pilo/data`, enables `pgvector` and
applies the migrations. There is nothing to install first and no password to
keep: the database is a directory only your account can read.

Then register your agents once — in the dashboard's Agents tab — and Pilo writes
the instruction block into each agent's `CLAUDE.md` or `AGENTS.md`.

## State and the database

Everything Pilo keeps lives under `~/.pilo/`: `config.toml`, `port`, `logs/`, and
`data/` — the database itself. There is no container and no separate server: the
database is [PGlite](https://pglite.dev), PostgreSQL 18 compiled to WebAssembly,
opened by the Pilo server as a directory of files. `pgvector` is enabled in it,
so nothing is given up by not running a real server.

One process owns that directory at a time. Pilo writes `~/.pilo/db.lock` when it
opens the database and refuses to start if another server still holds it — PGlite
has no lock of its own, and two writers would corrupt the files.

Every part of that layout can be moved, which is how a second instance runs
beside the first: `PILO_HOME` (state directory), `PILO_DATA` (database
directory), `PILO_PORT`, `PILO_SOCKET`, `PILO_SPOOL`, and `PILO_WATCHER=off` to
start without the loop that wakes agents. Move the socket and the spool together
— the CLI falls back from one to the other, so changing only one leaves it
talking to the instance you meant to leave alone.

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

The tree writes what each agent runs in front of its name — a brand glyph where
the icon font has one, three letters where it does not:

| Tier | When | Looks like |
| --- | --- | --- |
| icon | the default, with an icon font of Nerd Fonts 3.5.0 or newer | the brand glyph, `U+EC82` for Claude |
| letters | `:icons off` | `CLD pilo` |

`:icons` toggles, `:icons on` / `:icons off` say it outright, and the answer is
kept in the settings table, so the next run starts the same way. Three sources,
in order: what `:icons` said this run, what the last run saved, then the
environment — `PILO_ICONS=off` switches them off for a whole shell.

No terminal can be asked whether the font in use carries a glyph, so a machine
without an icon font shows a blank box until someone says `:icons off`. Every
other mark in the tree — the branches, the rules, the status dots, the badges —
uses characters a plain monospace font already has.

`PILO_AMBIGUOUS_WIDTH` forces the East Asian ambiguous width when the startup
probe cannot run.

## Design Contract

The dashboard and TUI must match `design/Pilo.dc.html`.

Do not redesign during implementation. If exact reproduction is blocked, update the design file first.
