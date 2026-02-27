# pfsense-toggle — Claude Code Context

## What this project is
A Node.js/Express web app that controls kids' internet access by toggling pfSense firewall block rules via the pfSense REST API, and disconnecting their devices from UniFi WiFi/ethernet. A card-based UI lets you allow/block each kid, set timed access, manage schedules, and skip schedule windows.

## Stack
- **Backend**: Node.js + Express (`server.js`)
- **Frontend**: Vanilla JS/HTML in `public/` (`index.html`, `schedule.html`, `log.html`, `settings.html`)
- **pfSense API**: REST v2 (`/api/v2/firewall/...`) — authenticated with `X-API-Key`
- **UniFi integration**: `unifi-maintenance-dashboard` at `UNIFI_DASHBOARD_URL` (separate service) — blocks/unblocks client MACs
- **State killing**: SSH to pfSense (`pfctl -k <ip>`) — key at `/root/.ssh/id_ed25519`, pfSense SSH on port 2222
- **Process manager**: pm2

## Key concepts
- Each kid has a **block rule** on pfSense (tracker ID). `disabled=true` → kid allowed; `disabled=false` → kid blocked.
- Each kid's rule source is a **pfSense alias** (e.g. `NadiaDevices`) containing their device IPs. The alias name is resolved via `GET /api/v2/firewall/aliases`.
- `HOME_RULES` in `.env` defines the kids — do not hardcode them in `server.js`.
- `schedules.json` persists schedule config locally (git-ignored); never committed.
- `settings.json` persists runtime-editable settings (pfSense URL/key, UniFi URL/site, ntfy URL) — overlays `.env` on startup; git-ignored.
- `action-log.json` persists the audit log (1000 entries, newest first); git-ignored.
- Schedule enforcement runs every 15 seconds server-side.
- When a kid is blocked, three things happen: pfSense rule enabled → `pfctl -k` kills existing connections → UniFi blocks each device MAC.
- When a kid is allowed, pfSense rule disabled → UniFi unblocks cached MACs (falls back to IP lookup if cache empty).

## Environment config (`.env`)
| Variable | Description |
|---|---|
| `PFSENSE_URL` | Base URL of pfSense instance (e.g. `https://10.40.0.1:5555`) |
| `PFSENSE_API_KEY` | pfSense REST API key |
| `TIMEZONE` | e.g. `America/New_York` — must be set before any Date ops |
| `HOME_RULES` | JSON array of `{ tracker, name, scheduleTracker }` — one per kid |
| `NTFY_URL` | Optional — full ntfy.sh topic URL for push notifications |
| `UNIFI_DASHBOARD_URL` | URL of unifi-maintenance-dashboard (e.g. `http://100.66.226.93:8000`) |
| `UNIFI_SITE` | UniFi site key (e.g. `default`) |

`.env` is git-ignored. See `.env.example` for format. Settings in `.env` can be overridden at runtime via `settings.json` (edited through `/settings` UI).

## Features
- **Dashboard** (`/`) — kid cards with toggle, schedule, timed access, skip-next, per-kid today's activity mini-log
- **Schedules** (`/schedule`) — per-kid time windows with day presets (M–F, Sa–Su, All)
- **Activity Log** (`/log`) — full audit log of all actions, auto-refreshes every 10s
- **Settings** (`/settings`) — edit connection config (pfSense, UniFi, ntfy), manage per-kid device IPs in pfSense aliases
- **PWA** — installable on mobile; manifest + service worker in `public/`
- **ntfy.sh** — push notifications on timer expiry, schedule changes, skips (set `NTFY_URL`)

## Block/allow flow (server.js)
**Block**: `pfsenseApiCall PATCH disabled:false` → `apply` → `killStatesForSource` (SSH pfctl) → `unifiBlockKid` (MAC lookup + block)
**Allow**: `pfsenseApiCall PATCH disabled:true` → `apply` → `unifiUnblockKid` (cached MACs or IP fallback)

Key functions:
- `pfctlKill(ip)` — SSH to pfSense, runs `pfctl -k <ip>`. Key: `/root/.ssh/id_ed25519`, port 2222.
- `resolveSourceIPs(source)` — if alias name, fetches `GET /api/v2/firewall/aliases` and extracts IPs.
- `killStatesForSource(sourceAddr, kidName)` — resolves alias → pfctlKill each IP.
- `ruleSourceAddr(rule)` — extracts alias name from pfSense rule object.
- `unifiBlockKid(tracker, sourceAddr, kidName)` — resolves IPs → queries UniFi clients → blocks each MAC → caches in `kidBlockedMacs`.
- `unifiUnblockKid(tracker, kidName, sourceAddr)` — unblocks cached MACs; falls back to IP lookup if cache empty.
- `getKidAlias(tracker)` — fetches rule + alias for a kid, returns `{ aliasName, aliasId, address, ips }`.
- `blockKidNow(tracker)` — timer expiry handler: re-blocks kid after timed allow expires.
- `enforceSchedules()` — runs every 15s, compares desired vs actual rule state, applies corrections.

## Rule tracker reference

| Kid     | Block tracker | Schedule tracker |
|---------|--------------|-----------------|
| Tristan | 1728781019   | 1728780997      |
| Lydia   | 1730164046   | 1730164014      |
| Nadia   | 1732587090   | 1732057261      |
| Katrina | 1733352318   | 1733352282      |

These are defined in `HOME_RULES` in `.env` — do not hardcode in `server.js`.

## pfSense API notes
- `GET /api/v2/firewall/rules` — list all rules; find kid's rule by `tracker` field.
- `PATCH /api/v2/firewall/rule` — update rule (body: `{ id, disabled }`).
- `POST /api/v2/firewall/apply` — must be called after any rule change.
- `GET /api/v2/firewall/aliases` — list all aliases (no per-name filter param).
- `PATCH /api/v2/firewall/alias` — update alias (body: `{ id, address: [...] }`).
- `DELETE /api/v2/firewall/states` — does NOT support IP filtering (confirmed). Use SSH `pfctl -k` instead.
- All calls use HTTPS with `rejectUnauthorized: false` (self-signed cert).

## UniFi integration notes
- `GET /api/clients?site=<site>` — returns all clients (wired + wireless) with `{ mac, ip, is_wired, blocked, ... }`.
- `POST /api/clients/block` — body: `{ mac, site }`. Works for both wired and wireless clients.
- `POST /api/clients/unblock` — body: `{ mac, site }`.
- UniFi dashboard runs at `UNIFI_DASHBOARD_URL` (Tailscale: `100.66.226.93:8000`).
- `kidBlockedMacs` Map (tracker → [mac, ...]) caches MACs across block/unblock so offline devices can still be unblocked.

## Files to keep in sync
- `server.js` — backend logic, API routes, audit log, ntfy notifications
- `public/index.html` — main dashboard
- `public/schedule.html` — schedule editor
- `public/log.html` — activity log page
- `public/settings.html` — settings + device management page
- `public/manifest.json` — PWA manifest
- `public/sw.js` — service worker
- `public/icon.svg` — app icon
- `.env.example` — always update when new env vars are added
- `CLAUDE.md` — this file; update whenever the architecture changes

## Running locally
```bash
pm2 restart pfsense-toggle --update-env   # restart after server.js changes (--update-env to pick up .env changes)
# or
node server.js               # run directly
```
Server listens on port **3030**.

## Git notes
- `.env`, `schedules.json`, `settings.json`, `action-log.json`, and `.claude/settings.local.json` are all git-ignored.
- Commits use identity: `waveworm / waveworm@users.noreply.github.com`
