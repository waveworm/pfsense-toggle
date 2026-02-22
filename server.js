const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();

// ============================================================================
// CONFIG BLOCK — Update these values
// ============================================================================
const CONFIG = {
  PFSENSE_URL: 'https://10.40.0.1:5555',
  API_KEY: '9af0148815969e75e4951d12646cf78e',
  // HOME (opt2) interface — these are BLOCK rules.
  // blockEnabled=true → kid is BLOCKED; blockEnabled=false → kid is ALLOWED outside schedule.
  HOME_RULES: [
    { tracker: 1728781019, name: 'Tristan', scheduleTracker: 1728780997 },
    { tracker: 1730164046, name: 'Lydia',   scheduleTracker: 1730164014 },
    { tracker: 1732587090, name: 'Nadia',   scheduleTracker: 1732057261 },
    { tracker: 1733352318, name: 'Katrina', scheduleTracker: 1733352282 }
  ]
};

// ============================================================================
// Timed-access state
// tracker -> { timeoutId, endTime, kidName }
// ============================================================================
const activeTimers = new Map();

async function blockKidNow(tracker) {
  try {
    const res = await pfsenseApiCall('/api/v2/firewall/rules');
    const rule = (res.data || []).find(r => r.tracker === tracker);
    if (rule && rule.disabled) {
      // block rule is currently disabled (kid allowed) — re-enable it to block
      await pfsenseApiCall('/api/v2/firewall/rule', 'PATCH', { id: rule.id, disabled: false });
      await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
    }
  } catch (err) {
    console.error(`Timer expired: failed to re-block tracker=${tracker}:`, err.message);
  }
  activeTimers.delete(tracker);
}

// ============================================================================
// Middleware
// ============================================================================
app.use(bodyParser.json());
app.use(express.static('public'));

// HTTPS Agent to skip certificate verification
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

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

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const text = await response.text();

    if (!response.ok) {
      console.error(`pfSense API error [${endpoint}]:`, response.status, text);
      return { error: true, status: response.status, message: text };
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      return { raw: text };
    }
  } catch (err) {
    console.error(`pfSense API call failed [${endpoint}]:`, err.message);
    return { error: true, message: err.message };
  }
}

// ============================================================================
// Routes
// ============================================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================================
// HOME / Kids routes
// ============================================================================

// GET /api/home/rules — Fetch current block-rule state for each kid
// enabled=true  → block rule is active   → kid is BLOCKED
// enabled=false → block rule is inactive → kid is ALLOWED
app.get('/api/home/rules', async (req, res) => {
  try {
    const rulesResponse = await pfsenseApiCall('/api/v2/firewall/rules');
    if (rulesResponse.error) {
      return res.status(500).json({ error: 'Failed to fetch rules from pfSense', details: rulesResponse.message });
    }

    const allRules = rulesResponse.data || [];
    const result = CONFIG.HOME_RULES.map(configRule => {
      const blockRule    = allRules.find(r => r.tracker === configRule.tracker);
      const scheduleRule = allRules.find(r => r.tracker === configRule.scheduleTracker);
      const timer = activeTimers.get(configRule.tracker);
      return {
        tracker:         configRule.tracker,
        scheduleTracker: configRule.scheduleTracker,
        name:            configRule.name,
        blockEnabled:    blockRule    ? !blockRule.disabled    : null,
        scheduleEnabled: scheduleRule ? !scheduleRule.disabled : null,
        timerEndTime:    timer ? timer.endTime : null,
        found:           !!blockRule
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

    const blockEnabled = !newDisabledState; // block rule active = kid blocked
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

// POST /api/home/rules/:tracker/toggle-schedule — Toggle one kid's scheduled internet rule
app.post('/api/home/rules/:tracker/toggle-schedule', async (req, res) => {
  try {
    const tracker = parseInt(req.params.tracker, 10);
    const configRule = CONFIG.HOME_RULES.find(r => r.tracker === tracker);
    if (!configRule) return res.status(404).json({ error: 'Kid rule not found in configuration' });

    const rulesResponse = await pfsenseApiCall('/api/v2/firewall/rules');
    if (rulesResponse.error) return res.status(500).json({ error: 'Failed to fetch current rule state', details: rulesResponse.message });

    const allRules = rulesResponse.data || [];
    const scheduleRule = allRules.find(r => r.tracker === configRule.scheduleTracker);
    if (!scheduleRule) return res.status(404).json({ error: 'Schedule rule not found on pfSense' });

    const newDisabledState = !scheduleRule.disabled;
    const updateResponse = await pfsenseApiCall('/api/v2/firewall/rule', 'PATCH', { id: scheduleRule.id, disabled: newDisabledState });
    if (updateResponse.error) return res.status(500).json({ error: 'Failed to update schedule rule', details: updateResponse.message });

    await pfsenseApiCall('/api/v2/firewall/apply', 'POST');

    const scheduleEnabled = !newDisabledState;
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

// POST /api/home/allow-all — Disable all block rules (allow all kids outside schedule)
app.post('/api/home/allow-all', async (req, res) => {
  try {
    const rulesResponse = await pfsenseApiCall('/api/v2/firewall/rules');
    if (rulesResponse.error) return res.status(500).json({ error: 'Failed to fetch rules', details: rulesResponse.message });

    const allRules = rulesResponse.data || [];
    let changed = 0;

    for (const homeRule of CONFIG.HOME_RULES) {
      const currentRule = allRules.find(r => r.tracker === homeRule.tracker);
      if (currentRule && !currentRule.disabled) {
        // Block rule is currently enabled → disable it to allow the kid
        await pfsenseApiCall('/api/v2/firewall/rule', 'PATCH', { id: currentRule.id, disabled: true });
        changed++;
      }
    }

    if (changed > 0) await pfsenseApiCall('/api/v2/firewall/apply', 'POST');
    res.json({ success: true, changed, message: 'All kids are now ALLOWED outside schedule' });
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
        // Block rule is currently disabled → enable it to block the kid
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

    res.json({ success: true, tracker, name: configRule.name, minutes, endTime,
      message: `${configRule.name} allowed for ${minutes} min` });
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
    // Re-block the kid immediately
    await blockKidNow(tracker);
    res.json({ success: true, message: 'Timer cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// ============================================================================
// Server startup
// ============================================================================
const PORT = 3030;

app.listen(PORT, () => {
  console.log(`\n✓ pfSense Kids Access running at http://localhost:${PORT}`);
  console.log(`✓ Configured ${CONFIG.HOME_RULES.length} kids for control`);
  console.log(`✓ Connected to pfSense: ${CONFIG.PFSENSE_URL}\n`);
});
