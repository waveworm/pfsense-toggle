require('dotenv').config();
// Must be set before any Date operations so getHours()/getDay() use local time
if (process.env.TIMEZONE) process.env.TZ = process.env.TIMEZONE;

const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

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
  HOME_RULES: JSON.parse(process.env.HOME_RULES || '[]')
};

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

async function blockKidNow(tracker) {
  activeTimers.delete(tracker);
  try {
    // If the app schedule is currently active and not skipped, don't re-block
    const info = computeScheduleInfo(String(tracker));
    const skipUntil = activeSkips.get(tracker);
    const skipActive = skipUntil && Date.now() < skipUntil;
    if (info.enabled && info.active && !skipActive) {
      console.log(`Timer expired: tracker=${tracker} is in schedule window — not re-blocking`);
      return;
    }
    const res = await pfsenseApiCall('/api/v2/firewall/rules');
    const rule = (res.data || []).find(r => r.tracker === tracker);
    if (rule && rule.disabled) {
      await pfsenseApiCall('/api/v2/firewall/rule', 'PATCH', { id: rule.id, disabled: false });
      await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
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
// Schedule Enforcement — runs every 60 seconds
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
      } else if (!shouldBeAllowed && kidIsAllowed) {
        // Should be blocked but is allowed — enable block rule
        await pfsenseApiCall('/api/v2/firewall/rule', 'PATCH', { id: blockRule.id, disabled: false });
        needsApply = true;
        if (skipActive) {
          console.log(`Skip: blocking ${kid.name} until ${new Date(skipUntil).toLocaleTimeString()}`);
        } else {
          console.log(`Schedule: blocking ${kid.name}`);
        }
      }
    }

    if (needsApply) await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
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
      }
    }

    if (changed > 0) await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
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

    for (const homeRule of CONFIG.HOME_RULES) {
      const currentRule = allRules.find(r => r.tracker === homeRule.tracker);
      if (currentRule && currentRule.disabled) {
        await pfsenseApiCall('/api/v2/firewall/rule', 'PATCH', { id: currentRule.id, disabled: false });
        changed++;
      }
    }

    if (changed > 0) await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
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
    }

    const endTime = Date.now() + minutes * 60 * 1000;
    const timeoutId = setTimeout(() => blockKidNow(tracker), minutes * 60 * 1000);
    activeTimers.set(tracker, { timeoutId, endTime, kidName: configRule.name });

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
      }

      const timeoutId = setTimeout(() => blockKidNow(configRule.tracker), minutes * 60 * 1000);
      activeTimers.set(configRule.tracker, { timeoutId, endTime, kidName: configRule.name });
    }

    await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
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
    activeSkips.delete(tracker);
    enforceSchedules().catch(err => console.error('Enforcement after skip cancel:', err.message));
    res.json({ success: true, message: 'Skip cancelled' });
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
  console.log(`✓ Schedule enforcement active (every 60s)`);
  console.log(`✓ Schedule page: http://localhost:${PORT}/schedule\n`);

  // Run initial schedule enforcement
  await enforceSchedules();

  // Run every 15 seconds
  setInterval(enforceSchedules, 15 * 1000);
});
