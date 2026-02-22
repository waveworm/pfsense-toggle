# pfsense-toggle — Claude Code Context

## What this project is
A Node.js/Express web app that controls kids' internet access by toggling pfSense firewall block rules via the pfSense REST API. A card-based UI lets you allow/block each kid, set timed access, manage schedules, and skip schedule windows.

## Stack
- **Backend**: Node.js + Express (`server.js`)
- **Frontend**: Vanilla JS/HTML in `public/` (`index.html`, `schedule.html`, `log.html`)
- **pfSense API**: REST v2 (`/api/v2/firewall/...`) — authenticated with `X-API-Key`
- **Process manager**: pm2

## Key concepts
- Each kid has a **block rule** on pfSense (tracker ID). `disabled=true` → kid allowed; `disabled=false` → kid blocked.
- `HOME_RULES` in `.env` defines the kids — do not hardcode them in `server.js`.
- `schedules.json` persists schedule config locally (git-ignored); never committed.
- Schedule enforcement runs every 15 seconds server-side.
- Audit log is in-memory (200 entries, `actionLog[]`), exposed at `GET /api/log`.

## Environment config (`.env`)
| Variable | Description |
|---|---|
| `PFSENSE_URL` | Base URL of pfSense instance |
| `PFSENSE_API_KEY` | pfSense REST API key |
| `TIMEZONE` | e.g. `America/New_York` — must be set before any Date ops |
| `HOME_RULES` | JSON array of `{ tracker, name, scheduleTracker }` — one per kid |
| `NTFY_URL` | Optional — full ntfy.sh topic URL for push notifications |

`.env` is git-ignored. See `.env.example` for format.

## Features
- **Dashboard** (`/`) — kid cards with toggle, schedule, timed access, skip-next, per-kid today's activity mini-log
- **Schedules** (`/schedule`) — per-kid time windows with day presets (M–F, Sa–Su, All)
- **Activity Log** (`/log`) — full audit log of all actions, auto-refreshes every 10s
- **PWA** — installable on mobile; manifest + service worker in `public/`
- **ntfy.sh** — push notifications on timer expiry, schedule changes, skips (set `NTFY_URL`)

## Files to keep in sync
- `server.js` — backend logic, API routes, audit log, ntfy notifications
- `public/index.html` — main dashboard
- `public/schedule.html` — schedule editor
- `public/log.html` — activity log page
- `public/manifest.json` — PWA manifest
- `public/sw.js` — service worker
- `public/icon.svg` — app icon
- `.env.example` — always update when new env vars are added
- `CLAUDE.md` — this file; update whenever the architecture changes

## Running locally
```bash
pm2 restart pfsense-toggle   # restart after server.js changes
# or
node server.js               # run directly
```
Server listens on port **3030**.

## Git notes
- `.env`, `schedules.json`, and `.claude/settings.local.json` are all git-ignored.
- Commits use identity: `waveworm / waveworm@users.noreply.github.com`
