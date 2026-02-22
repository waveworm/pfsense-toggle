# pfSense Kids Access Web App

A Node.js web application for controlling kids' internet access on the HOME (opt2) pfSense interface via the REST API v2.

## Overview

Dark-themed single-page app that controls per-kid firewall rules on pfSense at `https://10.40.0.1:5555`. Backend is Express.js on port 3030; frontend is vanilla HTML/CSS/JS.

## Project Structure

```
/root/pfsense-toggle/
├── server.js              # Express backend (port 3030)
├── package.json
├── public/
│   └── index.html         # Single-page frontend
└── node_modules/
```

## How the Rules Work

The HOME interface has two rule types per kid:

1. **Block rule** — always-on block rule. When *enabled* (disabled=false in pfSense), the kid is BLOCKED. Disabling it (disabled=true) allows the kid outside of schedule hours.
2. **Schedule rule** — a pass rule tied to a pfSense schedule. When enabled, the kid gets internet during scheduled hours. Disabling it cuts internet entirely.

To allow a kid outside schedule hours → disable their block rule.
To cut internet completely → disable their schedule rule.

## Backend API (`server.js`)

### Kids rules

- **GET /api/home/rules** — Fetch all 4 kids' current states
  - Returns per kid: `tracker`, `scheduleTracker`, `name`, `blockEnabled`, `scheduleEnabled`, `timerEndTime`
  - `blockEnabled: true` = block rule active = kid is BLOCKED
  - `scheduleEnabled: true` = schedule rule active = kid gets internet on schedule
  - `timerEndTime` = ms timestamp when timed access expires, or null

- **POST /api/home/rules/:tracker/toggle** — Toggle one kid's block rule
  - Returns: `{ success, tracker, name, blockEnabled, message }`

- **POST /api/home/rules/:tracker/toggle-schedule** — Toggle one kid's schedule rule
  - Returns: `{ success, tracker, name, scheduleEnabled, message }`

- **POST /api/home/allow-all** — Disable all 4 block rules (allow all kids outside schedule)
- **POST /api/home/block-all** — Enable all 4 block rules (block all kids)

### Timed access (server-side timers — survives browser close)

- **POST /api/home/rules/:tracker/timed-allow** — Allow one kid for N minutes, then auto-block
  - Body: `{ minutes: N }` (1–120)
  - Returns: `{ success, tracker, name, minutes, endTime, message }`

- **POST /api/home/allow-all-timed** — Allow all kids for N minutes
  - Body: `{ minutes: N }`

- **POST /api/home/rules/:tracker/cancel-timer** — Cancel active timer, re-block immediately

- **GET /health** — Health check

## Frontend Features

- **Dark industrial theme** — #0d0f14 background, Share Tech Mono + Barlow fonts
- **Live connection status** — pulsing green dot
- **Allow All / Block All** buttons for the block rule across all kids
- **4 kid cards** (Tristan, Lydia, Nadia, Katrina), each with:
  - Outside Sched toggle — controls block rule (green = ALLOWED, red = BLOCKED)
  - Schedule toggle — controls schedule rule (green = ON, grey = OFF)
  - Amber countdown badge + cancel (×) button when a timed session is active
- **Timed Access section**:
  - Duration presets: 5, 10, 15, 30, 45, 60, 75, 90, 105, 120 min (one selected at a time, amber highlight)
  - Custom minute input field (1–120) clears preset selection
  - Buttons: All Kids + individual kid buttons (Tristan, Lydia, Nadia, Katrina)
  - Countdowns tick every second client-side; API refreshes every 30 s
- **Toast notifications** — success/error on every action
- **Auto-refresh** — polls `/api/home/rules` every 30 s

## Configuration

Sensitive values are stored in `.env` (never committed to git). `server.js` loads them via `dotenv`.

### `.env` (local only, git-ignored)

```
PFSENSE_API_KEY=your_api_key_here
PFSENSE_URL=https://10.40.0.1:5555
```

Copy `.env.example` to `.env` and fill in the real key.

### `server.js` CONFIG block

```javascript
const CONFIG = {
  PFSENSE_URL: process.env.PFSENSE_URL || 'https://10.40.0.1:5555',
  API_KEY: process.env.PFSENSE_API_KEY,
  HOME_RULES: [
    { tracker: 1728781019, name: 'Tristan', scheduleTracker: 1728780997 },
    { tracker: 1730164046, name: 'Lydia',   scheduleTracker: 1730164014 },
    { tracker: 1732587090, name: 'Nadia',   scheduleTracker: 1732057261 },
    { tracker: 1733352318, name: 'Katrina', scheduleTracker: 1733352282 }
  ]
};
```

**API Key**: Loaded from `.env`, never exposed to the browser or committed to git.

## Rule Trackers Reference

| Kid     | Block tracker | Block rule id | Schedule tracker | Schedule rule id |
|---------|--------------|---------------|-----------------|-----------------|
| Tristan | 1728781019   | 67            | 1728780997      | 63              |
| Lydia   | 1730164046   | 68            | 1730164014      | 66              |
| Nadia   | 1732587090   | 69            | 1732057261      | 64              |
| Katrina | 1733352318   | 70            | 1733352282      | 65              |

## pfSense API Details

- **Host**: https://10.40.0.1:5555
- **Auth**: `X-API-Key` header
- **SSL**: self-signed cert, `rejectUnauthorized: false`
- **Endpoints used**:
  - `GET /api/v2/firewall/rules` — list all rules
  - `PATCH /api/v2/firewall/rule` body `{ id, disabled }` — update a rule (NOT PUT, NOT /:tracker)
  - `POST /api/v2/firewall/apply` — apply pending changes

## Claude Permissions (`.claude/settings.local.json`)

```json
{
  "permissions": {
    "allow": [
      "Bash(python3:*)",
      "Bash(pm2 restart:*)",
      "Bash(curl:*)"
    ]
  }
}
```

## Dependencies

- **express** — web framework
- **node-fetch** v2 — HTTP client
- **body-parser** — request body parsing

## PM2 Management

```bash
pm2 restart pfsense-toggle
pm2 logs pfsense-toggle --lines 30
pm2 list
```

## Setup

```bash
cd /root/pfsense-toggle
npm install
pm2 start server.js --name pfsense-toggle
pm2 save && pm2 startup
```

Access at http://localhost:3030

## Security Notes

- API key is server-side only
- ⚠️ Regenerate the API key in pfSense after confirming the app works:
  1. pfSense → System → API → Manage API Keys
  2. Revoke current key, create new one
  3. Update `CONFIG.API_KEY` in `server.js`
  4. `pm2 restart pfsense-toggle`
