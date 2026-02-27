require('dotenv').config();
// Must be set before any Date operations so getHours()/getDay() use local time
if (process.env.TIMEZONE) process.env.TZ = process.env.TIMEZONE;

const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const app = express();

// ============================================================================
// CONFIG BLOCK — values loaded from .env
// ============================================================================
const CONFIG = {
  PFSENSE_URL: process.env.PFSENSE_URL || 'https://10.40.0.1:5555',
  API_KEY: process.env.PFSENSE_API_KEY,
  // HOME (opt2) interface — these are BLOCK rules.
  // blockEnabled=true → kid is BLOCKED; blockEnabled=false → kid is ALLOWED outside schedule.
  // Loaded from HOME_RULES env var as JSON array: [{ tracker, name, scheduleTracker }, ...]
  HOME_RULES: JSON.parse(process.env.HOME_RULES || '[]'),
  // UniFi dashboard integration — set UNIFI_DASHBOARD_URL to enable WiFi client blocking
  UNIFI_URL: process.env.UNIFI_DASHBOARD_URL || '',
  UNIFI_SITE: process.env.UNIFI_SITE || 'default'
};

// ============================================================================
// Settings — persisted to settings.json, overlays .env values at startup.
// Allows runtime editing of connection config without restarting the server.
// ============================================================================
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// MACs that should never be blocked/unblocked via UniFi (pfSense rule still applies).
const unifiExcludedMacs = new Set();

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return;
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (s.pfsenseUrl)            CONFIG.PFSENSE_URL = s.pfsenseUrl;
    if (s.pfsenseApiKey)         CONFIG.API_KEY     = s.pfsenseApiKey;
    if (s.unifiUrl !== undefined) CONFIG.UNIFI_URL  = s.unifiUrl;
    if (s.unifiSite)             CONFIG.UNIFI_SITE  = s.unifiSite;
    if (s.ntfyUrl !== undefined)  process.env.NTFY_URL = s.ntfyUrl;
    if (Array.isArray(s.unifiExcludedMacs)) {
      unifiExcludedMacs.clear();
      s.unifiExcludedMacs.forEach(m => unifiExcludedMacs.add(m.toLowerCase()));
    }
  } catch (e) {
    console.error('Failed to load settings.json:', e.message);
  }
}

function saveSettings(data) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save settings.json:', e.message);
  }
}

loadSettings();

// ============================================================================
// Schedule config — persisted to schedules.json
// tracker (string) → { enabled: bool, windows: [{ days: [0-6], start: 'HH:MM', end: 'HH:MM' }] }
// days: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat  (JS Date.getDay() convention)
// ============================================================================
const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');

const DEFAULT_SCHEDULES = Object.fromEntries(
  CONFIG.HOME_RULES.map(r => [String(r.tracker), { enabled: false, windows: [] }])
);

function loadSchedules() {
  try {
    if (fs.existsSync(SCHEDULES_FILE)) {
      return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load schedules.json:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_SCHEDULES));
}

function saveSchedules() {
  try {
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(scheduleConfig, null, 2));
  } catch (e) {
    console.error('Failed to save schedules.json:', e.message);
  }
}

let scheduleConfig = loadSchedules();

// ============================================================================
// Schedule computation — pure local, no pfSense calls
// Returns { enabled, active, windowEnd: ms|null, nextStart: ms|null, nextEnd: ms|null }
// nextEnd is the end time of the next upcoming window (used for skip-next)
// ============================================================================
function timeToMinutes(t) {
  const [h, m] = (t || '0:0').split(':').map(Number);
  return h * 60 + (m || 0);
}

function computeScheduleInfo(tracker) {
  const config = scheduleConfig[String(tracker)];
  if (!config || !config.enabled || !Array.isArray(config.windows) || !config.windows.length) {
    return { enabled: !!(config && config.enabled), active: false, windowEnd: null, nextStart: null, nextEnd: null };
  }

  const now    = new Date();
  const today  = now.getDay(); // 0=Sun … 6=Sat
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // Check if currently inside any window
  let windowEndMs = null;
  for (const win of config.windows) {
    if (!win.days.includes(today)) continue;
    const startMin = timeToMinutes(win.start);
    const endMin   = timeToMinutes(win.end);
    if (nowMin >= startMin && nowMin < endMin) {
      const d = new Date(now);
      d.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
      if (windowEndMs === null || d.getTime() > windowEndMs) windowEndMs = d.getTime();
    }
  }
  if (windowEndMs !== null) {
    return { enabled: true, active: true, windowEnd: windowEndMs, nextStart: null, nextEnd: null };
  }

  // Not in any window — find the next upcoming window (within 7 days)
  // Also track nextEnd so skip-next knows when that window ends
  let nextStartMs = Infinity;
  let nextEndMs   = null;
  for (let offset = 0; offset < 7; offset++) {
    const checkDay = (today + offset) % 7;
    for (const win of config.windows) {
      if (!win.days.includes(checkDay)) continue;
      const startMin = timeToMinutes(win.start);
      if (offset === 0 && startMin <= nowMin) continue; // already passed today
      const d = new Date(now);
      d.setDate(d.getDate() + offset);
      d.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
      if (d.getTime() < nextStartMs) {
        nextStartMs = d.getTime();
        const endMin = timeToMinutes(win.end);
        const endD = new Date(d);
        endD.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
        nextEndMs = endD.getTime();
      }
    }
    if (nextStartMs < Infinity) break;
  }

  return {
    enabled:   true,
    active:    false,
    windowEnd: null,
    nextStart: nextStartMs < Infinity ? nextStartMs : null,
    nextEnd:   nextEndMs
  };
}

// ============================================================================
// Timed-access state
// tracker -> { timeoutId, endTime, kidName }
// ============================================================================
const activeTimers = new Map();

// ============================================================================
// Skip-next state — blocks a kid during their next schedule window
// tracker -> skipUntil (ms timestamp of window end)
// ============================================================================
const activeSkips = new Map();

// ============================================================================
// Audit Log — persisted to action-log.json, newest first, capped at 1000 entries
// ============================================================================
const ACTION_LOG_FILE = path.join(__dirname, 'action-log.json');

function loadActionLog() {
  try {
    if (fs.existsSync(ACTION_LOG_FILE)) return JSON.parse(fs.readFileSync(ACTION_LOG_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to load action-log.json:', e.message);
  }
  return [];
}

function saveActionLog() {
  try {
    fs.writeFileSync(ACTION_LOG_FILE, JSON.stringify(actionLog));
  } catch (e) {
    console.error('Failed to save action-log.json:', e.message);
  }
}

const actionLog = loadActionLog();

function logAction(action, kid, details) {
  actionLog.unshift({ ts: Date.now(), action, kid: kid || null, details: details || null });
  if (actionLog.length > 1000) actionLog.length = 1000;
  saveActionLog();
}

// ============================================================================
// ntfy.sh Push Notifications — set NTFY_URL in .env to enable
// e.g. NTFY_URL=https://ntfy.sh/my-topic
// ============================================================================
async function sendNotif(title, body) {
  const url = process.env.NTFY_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Title': title, 'Content-Type': 'text/plain' },
      body
    });
  } catch (err) {
    console.error('ntfy notification failed:', err.message);
  }
}

// ============================================================================
// Kill pfSense state table entries when a block rule is enabled.
// Uses SSH + pfctl -k <ip> -- the pfSense REST API v2 DELETE /firewall/states
// endpoint does not support filtering by IP (tested and confirmed).
// Key: /root/.ssh/id_ed25519 -- pre-authorized on pfSense at port 2222.
// ============================================================================

function pfctlKill(ip) {
  return new Promise((resolve) => {
    execFile('ssh', [
      '-i', '/root/.ssh/id_ed25519',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      '-o', 'BatchMode=yes',
      '-p', '2222',
      'root@10.40.0.1',
      'pfctl -k ' + ip
    ], (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout + stderr).trim() });
    });
  });
}

// Returns true if the string looks like a plain IP or CIDR (not an alias name).
function isIpOrCidr(s) {
  return /^[\d.:\/]+$/.test(s);
}

// Resolve a source value to a list of IP strings.
// If it's already an IP/CIDR, returns it directly.
// If it looks like an alias name, fetches the alias from pfSense and returns
// its member addresses.
async function resolveSourceIPs(source) {
  if (!source) return [];
  if (isIpOrCidr(source)) return [source];

  const res = await pfsenseApiCall('/api/v2/firewall/aliases');
  if (res.error || !res.data) {
    console.error(`resolveSourceIPs: could not fetch aliases:`, res.message || 'no data');
    return [];
  }

  const aliases = Array.isArray(res.data) ? res.data : [res.data];
  const match = aliases.find(a => a.name === source);
  if (!match) {
    console.error(`resolveSourceIPs: alias "${source}" not found in response`);
    return [];
  }

  const raw = match.address ?? match.entries ?? match.content ?? '';
  if (Array.isArray(raw)) {
    return raw.map(e => (typeof e === 'string' ? e : e.address)).filter(Boolean);
  }
  return String(raw).split(/\s+/).filter(Boolean);
}

async function killStatesForSource(sourceAddr, kidName) {
  if (!sourceAddr) return;
  const ips = await resolveSourceIPs(sourceAddr);
  if (!ips.length) {
    console.error(`killStates: no IPs resolved for ${kidName} (source="${sourceAddr}")`);
    return;
  }
  for (const ip of ips) {
    const { ok, out } = await pfctlKill(ip);
    if (ok) {
      console.log(`killStates: ${kidName} ip=${ip} — ${out}`);
    } else {
      console.error(`killStates: failed for ${kidName} ip=${ip} — ${out}`);
    }
  }
}

// ============================================================================
// UniFi WiFi Client Blocking — disconnects kid's devices when blocked.
// Requires unifi-maintenance-dashboard running at UNIFI_DASHBOARD_URL.
//
// Two persistent stores (both survive pm2 restarts):
//   known-macs.json  — tracker → [mac, ...] of every device ever seen per kid.
//                      Grows over time; used to block offline devices too.
//   blocked-macs.json — tracker → [mac, ...] currently blocked, for unblock.
// ============================================================================
const KNOWN_MACS_FILE   = path.join(__dirname, 'known-macs.json');
const BLOCKED_MACS_FILE = path.join(__dirname, 'blocked-macs.json');
const kidKnownMacs   = new Map(); // tracker → Set of known MACs
const kidBlockedMacs = new Map(); // tracker → [mac, ...] currently blocked

function loadMacFiles() {
  for (const [file, map, asSet] of [
    [KNOWN_MACS_FILE,   kidKnownMacs,   true],
    [BLOCKED_MACS_FILE, kidBlockedMacs, false],
  ]) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [tracker, macs] of Object.entries(data)) {
        if (Array.isArray(macs) && macs.length)
          map.set(Number(tracker), asSet ? new Set(macs) : macs);
      }
    } catch (e) { console.error(`Failed to load ${path.basename(file)}:`, e.message); }
  }
  if (kidKnownMacs.size) console.log(`Loaded known MACs for ${kidKnownMacs.size} kid(s)`);
  if (kidBlockedMacs.size) console.log(`Loaded blocked MACs for ${kidBlockedMacs.size} kid(s)`);
}

function saveKnownMacs() {
  try {
    const data = {};
    for (const [tracker, set] of kidKnownMacs) data[tracker] = [...set];
    fs.writeFileSync(KNOWN_MACS_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Failed to save known-macs.json:', e.message); }
}

function saveBlockedMacs() {
  try {
    const data = {};
    for (const [tracker, macs] of kidBlockedMacs) data[tracker] = macs;
    fs.writeFileSync(BLOCKED_MACS_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Failed to save blocked-macs.json:', e.message); }
}

// Record any newly seen MACs for a kid (called whenever we query clients).
// Excluded MACs (e.g. wired machines that should only be pfSense-blocked) are skipped.
function learnMacs(tracker, macs) {
  const filtered = macs.filter(m => !unifiExcludedMacs.has(m.toLowerCase()));
  if (!filtered.length) return;
  let set = kidKnownMacs.get(tracker);
  const before = set ? set.size : 0;
  if (!set) { set = new Set(); kidKnownMacs.set(tracker, set); }
  filtered.forEach(m => set.add(m));
  if (set.size > before) saveKnownMacs();
}

loadMacFiles();

async function unifiApiCall(method, endpoint, body = null) {
  if (!CONFIG.UNIFI_URL) return { error: true, message: 'UNIFI_DASHBOARD_URL not configured' };
  try {
    const options = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${CONFIG.UNIFI_URL}${endpoint}`, options);
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { return { raw: text }; }
  } catch (err) {
    console.error(`UniFi API call failed [${endpoint}]:`, err.message);
    return { error: true, message: err.message };
  }
}

// Block a kid's devices on UniFi.
// Queries the client list to find online devices → learns their MACs → blocks
// all known MACs for this kid (catches offline devices seen in past sessions).
async function unifiBlockKid(tracker, sourceAddr, kidName) {
  if (!CONFIG.UNIFI_URL) return;
  const ips = await resolveSourceIPs(sourceAddr);
  if (!ips.length) return;

  // Learn any currently-online MACs for this kid
  const clientsRes = await unifiApiCall('GET', `/api/clients?site=${CONFIG.UNIFI_SITE}`);
  if (!clientsRes.error && Array.isArray(clientsRes)) {
    const onlineMacs = ips.map(ip => clientsRes.find(c => c.ip === ip)?.mac).filter(Boolean);
    learnMacs(tracker, onlineMacs);
  }

  // Block all known MACs (online now + seen in past), skipping excluded ones
  const allMacs = [...(kidKnownMacs.get(tracker) || [])].filter(m => !unifiExcludedMacs.has(m.toLowerCase()));
  if (!allMacs.length) return;
  const blocked = [];
  for (const mac of allMacs) {
    const r = await unifiApiCall('POST', '/api/clients/block', { mac, site: CONFIG.UNIFI_SITE });
    if (!r.error) {
      blocked.push(mac);
      console.log(`unifiBlock: ${kidName} mac=${mac} — blocked`);
    } else {
      console.error(`unifiBlock: failed for ${kidName} mac=${mac} — ${r.message || r.detail}`);
    }
  }
  if (blocked.length) { kidBlockedMacs.set(tracker, blocked); saveBlockedMacs(); }
}

// Unblock a kid's devices on UniFi.
// Uses the blocked-MACs cache; also unblocks any other known MACs as a safety net.
async function unifiUnblockKid(tracker, kidName, sourceAddr = null) {
  if (!CONFIG.UNIFI_URL) return;

  // Union of cached blocked MACs + all known MACs, skipping excluded ones
  const toUnblock = new Set([
    ...(kidBlockedMacs.get(tracker) || []),
    ...(kidKnownMacs.get(tracker) || []),
  ].filter(m => !unifiExcludedMacs.has(m.toLowerCase())));

  // If we still have nothing, try IP lookup as last resort
  if (!toUnblock.size && sourceAddr) {
    const ips = await resolveSourceIPs(sourceAddr);
    if (ips.length) {
      const clientsRes = await unifiApiCall('GET', `/api/clients?site=${CONFIG.UNIFI_SITE}`);
      if (!clientsRes.error && Array.isArray(clientsRes)) {
        ips.map(ip => clientsRes.find(c => c.ip === ip)?.mac).filter(Boolean)
           .forEach(m => toUnblock.add(m));
      }
    }
  }

  if (!toUnblock.size) return;
  for (const mac of toUnblock) {
    const r = await unifiApiCall('POST', '/api/clients/unblock', { mac, site: CONFIG.UNIFI_SITE });
    if (!r.error) {
      console.log(`unifiUnblock: ${kidName} mac=${mac} — unblocked`);
    } else {
      console.error(`unifiUnblock: failed for ${kidName} mac=${mac} — ${r.message || r.detail}`);
    }
  }
  kidBlockedMacs.delete(tracker);
  saveBlockedMacs();
}

// Extract the source value from a pfSense rule object.
// The API returns source as either a plain string or an object like
// { address: "x.x.x.x" }, { network: "x.x.x.x/24" }, or { any: true }.
function ruleSourceAddr(rule) {
  const src = rule?.source;
  if (!src) return null;
  if (typeof src === 'string') return src;
  return src.address || src.network || null;
}

async function blockKidNow(tracker) {
  const timerData = activeTimers.get(tracker);
  activeTimers.delete(tracker);
  const kidName = timerData?.kidName || String(tracker);
  try {
    // If the app schedule is currently active and not skipped, don't re-block
    const info = computeScheduleInfo(String(tracker));
    const skipUntil = activeSkips.get(tracker);
    const skipActive = skipUntil && Date.now() < skipUntil;
    if (info.enabled && info.active && !skipActive) {
      console.log(`Timer expired: tracker=${tracker} is in schedule window — not re-blocking`);
      logAction('timer-expired', kidName, 'Timer ended — in schedule window, not re-blocked');
      return;
    }
    const res = await pfsenseApiCall('/api/v2/firewall/rules');
    const rule = (res.data || []).find(r => r.tracker === tracker);
    if (rule && rule.disabled) {
      await pfsenseApiCall('/api/v2/firewall/rule', 'PATCH', { id: rule.id, disabled: false });
      await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
      await killStatesForSource(ruleSourceAddr(rule), kidName);
      await unifiBlockKid(tracker, ruleSourceAddr(rule), kidName);
      logAction('timer-expired', kidName, 'Timer ended — blocked');
      sendNotif('Timer Expired', `${kidName}'s internet timer ended — now blocked`);
    }
  } catch (err) {
    console.error(`Timer expired: failed to re-block tracker=${tracker}:`, err.message);
  }
}

// ============================================================================
// Middleware
// ============================================================================
app.use(bodyParser.json());
app.use(express.static('public'));

// HTTPS Agent to skip certificate verification
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ============================================================================
// Helper: Make pfSense API calls
// ============================================================================
async function pfsenseApiCall(endpoint, method = 'GET', body = null) {
  try {
    const url = `${CONFIG.PFSENSE_URL}${endpoint}`;
    const options = {
      method,
      headers: {
        'X-API-Key': CONFIG.API_KEY,
        'Content-Type': 'application/json'
      },
      agent: httpsAgent
    };
    if (body) options.body = JSON.stringify(body);

    console.log(`API ${method} ${url}`);
    const response = await fetch(url, options);
    const text = await response.text();

    if (!response.ok) {
      console.error(`pfSense API error [${endpoint}]:`, response.status, text);
      return { error: true, status: response.status, message: text };
    }
    try { return JSON.parse(text); } catch (e) { return { raw: text }; }
  } catch (err) {
    console.error(`pfSense API call failed [${endpoint}]:`, err.message);
    return { error: true, message: err.message };
  }
}

// ============================================================================
// Schedule Enforcement — runs every 15 seconds
// Compares desired state (from scheduleConfig) vs actual pfSense rule state
// and applies corrections. Skips kids with active timed-access timers.
// ============================================================================
async function enforceSchedules() {
  try {
    // Clean up expired skips
    for (const [t, su] of activeSkips) {
      if (Date.now() >= su) activeSkips.delete(t);
    }

    const rulesRes = await pfsenseApiCall('/api/v2/firewall/rules');
    if (rulesRes.error) {
      console.error('Schedule enforcement: failed to fetch pfSense rules');
      return;
    }
    const allRules = rulesRes.data || [];
    let needsApply = false;
    const toKillStates = [];

    for (const kid of CONFIG.HOME_RULES) {
      // Skip if a manual timer is active for this kid
      if (activeTimers.has(kid.tracker)) continue;

      const info = computeScheduleInfo(String(kid.tracker));
      if (!info.enabled) continue; // schedule disabled for this kid

      const blockRule = allRules.find(r => r.tracker === kid.tracker);
      if (!blockRule) continue;

      // blockRule.disabled=true  → kid is ALLOWED  (block rule bypassed)
      // blockRule.disabled=false → kid is BLOCKED   (block rule active)
      const kidIsAllowed = blockRule.disabled;

      // A skip overrides the schedule: treat the kid as "should be blocked"
      const skipUntil = activeSkips.get(kid.tracker);
      const skipActive = skipUntil && Date.now() < skipUntil;
      const shouldBeAllowed = info.active && !skipActive;

      if (shouldBeAllowed && !kidIsAllowed) {
        // Should be allowed but is blocked — disable block rule
        await pfsenseApiCall('/api/v2/firewall/rule', 'PATCH', { id: blockRule.id, disabled: true });
        needsApply = true;
        console.log(`Schedule: allowing ${kid.name}`);
        logAction('schedule-allow', kid.name, 'Schedule window opened');
        sendNotif('Schedule', `${kid.name} — internet allowed (schedule window opened)`);
        await unifiUnblockKid(kid.tracker, kid.name, ruleSourceAddr(blockRule));
      } else if (!shouldBeAllowed && kidIsAllowed) {
        // Should be blocked but is allowed — enable block rule
        await pfsenseApiCall('/api/v2/firewall/rule', 'PATCH', { id: blockRule.id, disabled: false });
        needsApply = true;
        if (skipActive) {
          console.log(`Skip: blocking ${kid.name} until ${new Date(skipUntil).toLocaleTimeString()}`);
          logAction('schedule-block', kid.name, `Skipped until ${new Date(skipUntil).toLocaleTimeString()}`);
        } else {
          console.log(`Schedule: blocking ${kid.name}`);
          logAction('schedule-block', kid.name, 'Schedule window closed');
        }
        sendNotif('Schedule', `${kid.name} — internet blocked`);
        toKillStates.push({ rule: blockRule, name: kid.name, tracker: kid.tracker });
      }
    }

    if (needsApply) {
      await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
      for (const { rule, name, tracker } of toKillStates) {
        await killStatesForSource(ruleSourceAddr(rule), name);
        await unifiBlockKid(tracker, ruleSourceAddr(rule), name);
      }
    }
  } catch (err) {
    console.error('Schedule enforcement error:', err.message);
  }
}

// ============================================================================
// Routes
// ============================================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Schedule config page
app.get('/schedule', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'schedule.html'));
});

// Activity log page
app.get('/log', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'log.html'));
});

// Settings page
app.get('/settings', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// GET /api/log — return audit log
app.get('/api/log', (_req, res) => {
  res.json({ success: true, log: actionLog });
});

// ============================================================================
// Settings API
// ============================================================================

// GET /api/settings — return current settings (API key masked)
app.get('/api/settings', (_req, res) => {
  res.json({
    success: true,
    pfsenseUrl:    CONFIG.PFSENSE_URL,
    hasApiKey:     !!CONFIG.API_KEY,
    unifiUrl:      CONFIG.UNIFI_URL,
    unifiSite:     CONFIG.UNIFI_SITE,
    ntfyUrl:       process.env.NTFY_URL || ''
  });
});

// PUT /api/settings — save settings to settings.json and hot-reload CONFIG
app.put('/api/settings', (req, res) => {
  try {
    const { pfsenseUrl, pfsenseApiKey, unifiUrl, unifiSite, ntfyUrl } = req.body;
    const SENTINEL = '••••••••';

    // Load existing saved settings to merge (don't wipe unsent fields)
    let saved = {};
    try {
      if (fs.existsSync(SETTINGS_FILE)) saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (_) {}

    if (pfsenseUrl !== undefined) {
      saved.pfsenseUrl = pfsenseUrl;
      CONFIG.PFSENSE_URL = pfsenseUrl;
    }
    // Only update API key if a real value was sent (not the sentinel placeholder)
    if (pfsenseApiKey !== undefined && pfsenseApiKey !== SENTINEL && pfsenseApiKey !== '') {
      saved.pfsenseApiKey = pfsenseApiKey;
      CONFIG.API_KEY = pfsenseApiKey;
    }
    if (unifiUrl !== undefined) {
      saved.unifiUrl = unifiUrl;
      CONFIG.UNIFI_URL = unifiUrl;
    }
    if (unifiSite !== undefined) {
      saved.unifiSite = unifiSite;
      CONFIG.UNIFI_SITE = unifiSite;
    }
    if (ntfyUrl !== undefined) {
      saved.ntfyUrl = ntfyUrl;
      process.env.NTFY_URL = ntfyUrl;
    }

    saveSettings(saved);
    logAction('settings-saved', null, 'Settings updated');
    res.json({ success: true, message: 'Settings saved' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// ============================================================================
// Device management API — manage IPs in a kid's pfSense alias
// ============================================================================

// Helper: fetch alias for a kid's rule. Returns { aliasName, aliasId, address, ips }
async function getKidAlias(tracker) {
  const rulesRes = await pfsenseApiCall('/api/v2/firewall/rules');
  if (rulesRes.error) throw new Error('Failed to fetch pfSense rules');
  const rule = (rulesRes.data || []).find(r => r.tracker === tracker);
  if (!rule) throw new Error(`Rule not found for tracker ${tracker}`);
  const aliasName = ruleSourceAddr(rule);
  if (!aliasName || isIpOrCidr(aliasName)) throw new Error('Rule source is not an alias name');

  const aliasesRes = await pfsenseApiCall('/api/v2/firewall/aliases');
  if (aliasesRes.error) throw new Error('Failed to fetch pfSense aliases');
  const aliases = Array.isArray(aliasesRes.data) ? aliasesRes.data : [aliasesRes.data];
  const alias = aliases.find(a => a.name === aliasName);
  if (!alias) throw new Error(`Alias "${aliasName}" not found`);

  // address may be strings or {address: "ip"} objects
  const raw = alias.address ?? alias.entries ?? alias.content ?? [];
  const entries = Array.isArray(raw) ? raw : String(raw).split(/\s+/).filter(Boolean);
  const ips = entries.map(e => (typeof e === 'string' ? e : e.address)).filter(Boolean);
  return { aliasName, aliasId: alias.id, address: entries, ips };
}

// GET /api/kids/:tracker/devices — list IPs in kid's pfSense alias
app.get('/api/kids/:tracker/devices', async (req, res) => {
  try {
    const tracker = parseInt(req.params.tracker, 10);
    const configRule = CONFIG.HOME_RULES.find(r => r.tracker === tracker);
    if (!configRule) return res.status(404).json({ error: 'Kid not found' });
    const { aliasName, ips } = await getKidAlias(tracker);
    res.json({ success: true, name: configRule.name, aliasName, ips });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/kids/:tracker/devices — add an IP to kid's pfSense alias
app.post('/api/kids/:tracker/devices', async (req, res) => {
  try {
    const tracker = parseInt(req.params.tracker, 10);
    const configRule = CONFIG.HOME_RULES.find(r => r.tracker === tracker);
    if (!configRule) return res.status(404).json({ error: 'Kid not found' });
    const ip = (req.body.ip || '').trim();
    if (!ip || !/^[\d.:\/]+$/.test(ip)) return res.status(400).json({ error: 'Invalid IP address' });

    const { aliasName, aliasId, address, ips } = await getKidAlias(tracker);
    if (ips.includes(ip)) return res.status(409).json({ error: 'IP already in alias' });

    // Append new entry preserving original format
    const newAddress = typeof address[0] === 'string' || !address.length
      ? [...address, ip]
      : [...address, { address: ip }];

    const updateRes = await pfsenseApiCall('/api/v2/firewall/alias', 'PATCH', { id: aliasId, address: newAddress });
    if (updateRes.error) return res.status(500).json({ error: 'Failed to update alias', details: updateRes.message });
    await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
    logAction('device-add', configRule.name, `Added ${ip} to ${aliasName}`);
    res.json({ success: true, aliasName, ips: [...ips, ip] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/kids/:tracker/devices/:ip — remove an IP from kid's pfSense alias
app.delete('/api/kids/:tracker/devices/:ip', async (req, res) => {
  try {
    const tracker = parseInt(req.params.tracker, 10);
    const configRule = CONFIG.HOME_RULES.find(r => r.tracker === tracker);
    if (!configRule) return res.status(404).json({ error: 'Kid not found' });
    const ip = req.params.ip;

    const { aliasName, aliasId, address, ips } = await getKidAlias(tracker);
    if (!ips.includes(ip)) return res.status(404).json({ error: 'IP not found in alias' });
    if (ips.length <= 1) return res.status(400).json({ error: 'Cannot remove last IP from alias' });

    const newAddress = address.filter(e => (typeof e === 'string' ? e : e.address) !== ip);
    const updateRes = await pfsenseApiCall('/api/v2/firewall/alias', 'PATCH', { id: aliasId, address: newAddress });
    if (updateRes.error) return res.status(500).json({ error: 'Failed to update alias', details: updateRes.message });
    await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
    logAction('device-remove', configRule.name, `Removed ${ip} from ${aliasName}`);
    res.json({ success: true, aliasName, ips: ips.filter(i => i !== ip) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// HOME / Kids routes
// ============================================================================

// GET /api/home/rules — Fetch current block-rule state for each kid
app.get('/api/home/rules', async (req, res) => {
  try {
    const rulesResponse = await pfsenseApiCall('/api/v2/firewall/rules');
    if (rulesResponse.error) {
      return res.status(500).json({ error: 'Failed to fetch rules from pfSense', details: rulesResponse.message });
    }

    const allRules = rulesResponse.data || [];
    const now = Date.now();
    const result = CONFIG.HOME_RULES.map(configRule => {
      const blockRule  = allRules.find(r => r.tracker === configRule.tracker);
      const timer      = activeTimers.get(configRule.tracker);
      const schedInfo  = computeScheduleInfo(String(configRule.tracker));
      const skipUntilMs = activeSkips.get(configRule.tracker);
      const skipUntil  = (skipUntilMs && now < skipUntilMs) ? skipUntilMs : null;

      return {
        tracker:           configRule.tracker,
        scheduleTracker:   configRule.scheduleTracker,
        name:              configRule.name,
        blockEnabled:      blockRule ? !blockRule.disabled : null,
        scheduleEnabled:   schedInfo.enabled,
        scheduleActive:    schedInfo.active,
        scheduleWindowEnd: schedInfo.windowEnd,
        scheduleNextStart: schedInfo.nextStart,
        scheduleNextEnd:   schedInfo.nextEnd,
        timerEndTime:      timer ? timer.endTime : null,
        skipUntil,
        found:             !!blockRule
      };
    });

    res.json({ success: true, rules: result, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// POST /api/home/rules/:tracker/toggle — Toggle one kid's block rule
app.post('/api/home/rules/:tracker/toggle', async (req, res) => {
  try {
    const tracker = parseInt(req.params.tracker, 10);
    const configRule = CONFIG.HOME_RULES.find(r => r.tracker === tracker);
    if (!configRule) return res.status(404).json({ error: 'Kid rule not found in configuration' });

    const rulesResponse = await pfsenseApiCall('/api/v2/firewall/rules');
    if (rulesResponse.error) return res.status(500).json({ error: 'Failed to fetch current rule state', details: rulesResponse.message });

    const allRules = rulesResponse.data || [];
    const currentRule = allRules.find(r => r.tracker === tracker);
    if (!currentRule) return res.status(404).json({ error: 'Rule not found on pfSense' });

    const newDisabledState = !currentRule.disabled;
    const updateResponse = await pfsenseApiCall('/api/v2/firewall/rule', 'PATCH', { id: currentRule.id, disabled: newDisabledState });
    if (updateResponse.error) return res.status(500).json({ error: 'Failed to update rule', details: updateResponse.message });

    await pfsenseApiCall('/api/v2/firewall/apply', 'POST');

    const blockEnabled = !newDisabledState;
    // Kill existing states so blocking takes effect immediately (e.g. iMessage)
    if (blockEnabled) {
      await killStatesForSource(ruleSourceAddr(currentRule), configRule.name);
      await unifiBlockKid(tracker, ruleSourceAddr(currentRule), configRule.name);
    } else {
      await unifiUnblockKid(tracker, configRule.name, ruleSourceAddr(currentRule));
    }
    logAction(blockEnabled ? 'toggle-block' : 'toggle-allow', configRule.name,
      blockEnabled ? 'Manually blocked' : 'Manually allowed');
    res.json({
      success: true,
      tracker,
      name: configRule.name,
      blockEnabled,
      message: `${configRule.name} is now ${blockEnabled ? 'BLOCKED' : 'ALLOWED'}`
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// POST /api/home/rules/:tracker/toggle-schedule — Toggle app-managed schedule for one kid
app.post('/api/home/rules/:tracker/toggle-schedule', async (req, res) => {
  try {
    const tracker = parseInt(req.params.tracker, 10);
    const configRule = CONFIG.HOME_RULES.find(r => r.tracker === tracker);
    if (!configRule) return res.status(404).json({ error: 'Kid not found in configuration' });

    const key = String(tracker);
    if (!scheduleConfig[key]) scheduleConfig[key] = { enabled: false, windows: [] };
    scheduleConfig[key].enabled = !scheduleConfig[key].enabled;
    saveSchedules();

    // Apply enforcement in background
    enforceSchedules().catch(err => console.error('Enforcement after toggle:', err.message));

    const scheduleEnabled = scheduleConfig[key].enabled;
    logAction('schedule-toggle', configRule.name, `Schedule ${scheduleEnabled ? 'enabled' : 'disabled'}`);
    res.json({
      success: true,
      tracker,
      name: configRule.name,
      scheduleEnabled,
      message: `${configRule.name}'s schedule is now ${scheduleEnabled ? 'ON' : 'OFF'}`
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// POST /api/home/allow-all — Disable all block rules (allow all kids)
app.post('/api/home/allow-all', async (req, res) => {
  try {
    const rulesResponse = await pfsenseApiCall('/api/v2/firewall/rules');
    if (rulesResponse.error) return res.status(500).json({ error: 'Failed to fetch rules', details: rulesResponse.message });

    const allRules = rulesResponse.data || [];
    let changed = 0;

    for (const homeRule of CONFIG.HOME_RULES) {
      const currentRule = allRules.find(r => r.tracker === homeRule.tracker);
      if (currentRule && !currentRule.disabled) {
        await pfsenseApiCall('/api/v2/firewall/rule', 'PATCH', { id: currentRule.id, disabled: true });
        changed++;
        await unifiUnblockKid(homeRule.tracker, homeRule.name, ruleSourceAddr(currentRule));
      }
    }

    if (changed > 0) await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
    logAction('allow-all', null, `${changed} kids allowed`);
    res.json({ success: true, changed, message: 'All kids are now ALLOWED' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// POST /api/home/block-all — Enable all block rules (block all kids)
app.post('/api/home/block-all', async (req, res) => {
  try {
    const rulesResponse = await pfsenseApiCall('/api/v2/firewall/rules');
    if (rulesResponse.error) return res.status(500).json({ error: 'Failed to fetch rules', details: rulesResponse.message });

    const allRules = rulesResponse.data || [];
    let changed = 0;

    const toKillStates = [];
    for (const homeRule of CONFIG.HOME_RULES) {
      const currentRule = allRules.find(r => r.tracker === homeRule.tracker);
      if (currentRule && currentRule.disabled) {
        await pfsenseApiCall('/api/v2/firewall/rule', 'PATCH', { id: currentRule.id, disabled: false });
        toKillStates.push({ rule: currentRule, name: homeRule.name, tracker: homeRule.tracker });
        changed++;
      }
    }

    if (changed > 0) {
      await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
      for (const { rule, name, tracker } of toKillStates) {
        await killStatesForSource(ruleSourceAddr(rule), name);
        await unifiBlockKid(tracker, ruleSourceAddr(rule), name);
      }
    }
    logAction('block-all', null, `${changed} kids blocked`);
    res.json({ success: true, changed, message: 'All kids are now BLOCKED' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// ============================================================================
// Schedule config API
// ============================================================================

// GET /api/schedules — Return current schedule config with kid metadata
app.get('/api/schedules', (req, res) => {
  const kids = CONFIG.HOME_RULES.map(r => ({
    tracker: String(r.tracker),
    name: r.name,
    config: scheduleConfig[String(r.tracker)] || { enabled: false, windows: [] }
  }));
  res.json({ success: true, schedules: scheduleConfig, kids });
});

// PUT /api/schedules — Save entire schedule config
app.put('/api/schedules', (req, res) => {
  try {
    const incoming = req.body;
    for (const [tracker, config] of Object.entries(incoming)) {
      if (typeof config.enabled !== 'boolean') {
        return res.status(400).json({ error: `Invalid enabled value for tracker ${tracker}` });
      }
      if (!Array.isArray(config.windows)) {
        return res.status(400).json({ error: `Invalid windows for tracker ${tracker}` });
      }
      for (const win of config.windows) {
        if (!Array.isArray(win.days) || typeof win.start !== 'string' || typeof win.end !== 'string') {
          return res.status(400).json({ error: 'Invalid window entry' });
        }
      }
    }
    scheduleConfig = incoming;
    saveSchedules();
    logAction('schedules-saved', null, `${Object.keys(incoming).length} kids updated`);
    enforceSchedules().catch(err => console.error('Enforcement after save:', err.message));
    res.json({ success: true, message: 'Schedules saved' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// POST /api/schedules/disable-all — Disable all schedules
app.post('/api/schedules/disable-all', (req, res) => {
  for (const key of Object.keys(scheduleConfig)) {
    scheduleConfig[key].enabled = false;
  }
  saveSchedules();
  enforceSchedules().catch(err => console.error('Enforcement after disable-all:', err.message));
  res.json({ success: true, message: 'All schedules disabled' });
});

// POST /api/schedules/enable-all — Enable all schedules
app.post('/api/schedules/enable-all', (req, res) => {
  for (const key of Object.keys(scheduleConfig)) {
    scheduleConfig[key].enabled = true;
  }
  saveSchedules();
  enforceSchedules().catch(err => console.error('Enforcement after enable-all:', err.message));
  res.json({ success: true, message: 'All schedules enabled' });
});

// ============================================================================
// Timed-access routes
// ============================================================================

// POST /api/home/rules/:tracker/timed-allow  body: { minutes: N }
app.post('/api/home/rules/:tracker/timed-allow', async (req, res) => {
  try {
    const tracker = parseInt(req.params.tracker, 10);
    const minutes = parseInt(req.body.minutes, 10);
    if (!minutes || minutes < 1 || minutes > 120) {
      return res.status(400).json({ error: 'minutes must be 1–120' });
    }
    const configRule = CONFIG.HOME_RULES.find(r => r.tracker === tracker);
    if (!configRule) return res.status(404).json({ error: 'Kid not found' });

    // Cancel any existing timer for this kid
    const existing = activeTimers.get(tracker);
    if (existing) clearTimeout(existing.timeoutId);

    // Allow the kid now (disable the block rule)
    const rulesRes = await pfsenseApiCall('/api/v2/firewall/rules');
    if (rulesRes.error) return res.status(500).json({ error: 'Failed to fetch rules', details: rulesRes.message });
    const blockRule = (rulesRes.data || []).find(r => r.tracker === tracker);
    if (blockRule && !blockRule.disabled) {
      await pfsenseApiCall('/api/v2/firewall/rule', 'PATCH', { id: blockRule.id, disabled: true });
      await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
      await unifiUnblockKid(tracker, configRule.name, ruleSourceAddr(blockRule));
    }

    const endTime = Date.now() + minutes * 60 * 1000;
    const timeoutId = setTimeout(() => blockKidNow(tracker), minutes * 60 * 1000);
    activeTimers.set(tracker, { timeoutId, endTime, kidName: configRule.name });
    logAction('timed-allow', configRule.name, `${minutes} min`);

    res.json({
      success: true, tracker, name: configRule.name, minutes, endTime,
      message: `${configRule.name} allowed for ${minutes} min`
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// POST /api/home/allow-all-timed  body: { minutes: N }
app.post('/api/home/allow-all-timed', async (req, res) => {
  try {
    const minutes = parseInt(req.body.minutes, 10);
    if (!minutes || minutes < 1 || minutes > 120) {
      return res.status(400).json({ error: 'minutes must be 1–120' });
    }

    const rulesRes = await pfsenseApiCall('/api/v2/firewall/rules');
    if (rulesRes.error) return res.status(500).json({ error: 'Failed to fetch rules', details: rulesRes.message });
    const allRules = rulesRes.data || [];

    const endTime = Date.now() + minutes * 60 * 1000;

    for (const configRule of CONFIG.HOME_RULES) {
      const existing = activeTimers.get(configRule.tracker);
      if (existing) clearTimeout(existing.timeoutId);

      const blockRule = allRules.find(r => r.tracker === configRule.tracker);
      if (blockRule && !blockRule.disabled) {
        await pfsenseApiCall('/api/v2/firewall/rule', 'PATCH', { id: blockRule.id, disabled: true });
        await unifiUnblockKid(configRule.tracker, configRule.name, ruleSourceAddr(blockRule));
      }

      const timeoutId = setTimeout(() => blockKidNow(configRule.tracker), minutes * 60 * 1000);
      activeTimers.set(configRule.tracker, { timeoutId, endTime, kidName: configRule.name });
    }

    await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
    for (const configRule of CONFIG.HOME_RULES) {
      logAction('timed-allow', configRule.name, `${minutes} min`);
    }
    res.json({ success: true, minutes, endTime, message: `All kids allowed for ${minutes} min` });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// POST /api/home/rules/:tracker/cancel-timer
app.post('/api/home/rules/:tracker/cancel-timer', async (req, res) => {
  try {
    const tracker = parseInt(req.params.tracker, 10);
    const existing = activeTimers.get(tracker);
    if (existing) {
      clearTimeout(existing.timeoutId);
      logAction('timer-cancel', existing.kidName, 'Timer cancelled manually');
      activeTimers.delete(tracker);
    }
    await blockKidNow(tracker);
    res.json({ success: true, message: 'Timer cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// ============================================================================
// Skip-next routes
// ============================================================================

// POST /api/home/rules/:tracker/skip-next
// Skips the currently-active window (if in one) or the next upcoming window.
// The kid stays blocked until the end of that window, then normal schedule resumes.
app.post('/api/home/rules/:tracker/skip-next', async (req, res) => {
  try {
    const tracker = parseInt(req.params.tracker, 10);
    const configRule = CONFIG.HOME_RULES.find(r => r.tracker === tracker);
    if (!configRule) return res.status(404).json({ error: 'Kid not found' });

    const info = computeScheduleInfo(String(tracker));
    let skipUntil = null;

    if (info.active && info.windowEnd) {
      // Currently in a window — skip until it ends
      skipUntil = info.windowEnd;
    } else if (info.nextEnd) {
      // Not in a window — skip the next upcoming window entirely
      skipUntil = info.nextEnd;
    }

    if (!skipUntil) {
      return res.status(400).json({ error: 'No upcoming schedule window to skip' });
    }

    activeSkips.set(tracker, skipUntil);

    // Apply immediately (blocks kid if currently in window)
    enforceSchedules().catch(err => console.error('Enforcement after skip:', err.message));

    const until = new Date(skipUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    logAction('skip-next', configRule.name, `Skipped until ${until}`);
    sendNotif('Skip', `${configRule.name}'s next window skipped until ${until}`);
    res.json({ success: true, tracker, name: configRule.name, skipUntil,
      message: `${configRule.name}'s next window skipped until ${until}` });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// POST /api/home/rules/:tracker/cancel-skip
app.post('/api/home/rules/:tracker/cancel-skip', async (req, res) => {
  try {
    const tracker = parseInt(req.params.tracker, 10);
    const skipRule = CONFIG.HOME_RULES.find(r => r.tracker === tracker);
    activeSkips.delete(tracker);
    logAction('skip-cancel', skipRule?.name || String(tracker), 'Skip cancelled');
    enforceSchedules().catch(err => console.error('Enforcement after skip cancel:', err.message));
    res.json({ success: true, message: 'Skip cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// POST /api/home/rules/:tracker/kill-states
app.post('/api/home/rules/:tracker/kill-states', async (req, res) => {
  try {
    const tracker = parseInt(req.params.tracker, 10);
    const configRule = CONFIG.HOME_RULES.find(r => r.tracker === tracker);
    if (!configRule) return res.status(404).json({ error: 'Kid not found in configuration' });

    const rulesResponse = await pfsenseApiCall('/api/v2/firewall/rules');
    if (rulesResponse.error) return res.status(500).json({ error: 'Failed to fetch rules', details: rulesResponse.message });

    const allRules = rulesResponse.data || [];
    const blockRule = allRules.find(r => r.tracker === tracker);
    if (!blockRule) return res.status(404).json({ error: 'Rule not found on pfSense' });

    await killStatesForSource(ruleSourceAddr(blockRule), configRule.name);
    logAction('kill-states', configRule.name, 'States killed manually');
    res.json({ success: true, tracker, name: configRule.name, message: `States killed for ${configRule.name}` });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// ============================================================================
// Server startup
// ============================================================================
const PORT = 3030;

app.listen(PORT, async () => {
  console.log(`\n✓ pfSense Kids Access running at http://localhost:${PORT}`);
  console.log(`✓ Configured ${CONFIG.HOME_RULES.length} kids for control`);
  console.log(`✓ Connected to pfSense: ${CONFIG.PFSENSE_URL}`);
  console.log(`✓ Schedule enforcement active (every 15s)`);
  console.log(`✓ Schedule page: http://localhost:${PORT}/schedule\n`);

  // Run initial schedule enforcement
  await enforceSchedules();

  // Run every 15 seconds
  setInterval(enforceSchedules, 15 * 1000);
});
