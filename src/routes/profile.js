const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const PROFILE = require('../data/profile');
const SNIPPETS = require('../data/snippets');

const OVERRIDES_PATH = path.join(__dirname, '..', '..', 'data', 'profile-overrides.json');

function loadOverrides() {
  try {
    if (fs.existsSync(OVERRIDES_PATH)) {
      return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('Failed to load profile overrides:', e.message);
  }
  return {};
}

function saveOverrides(overrides) {
  const dir = path.dirname(OVERRIDES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
}

function deepMerge(base, overrides) {
  const result = { ...base };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] && typeof overrides[key] === 'object' && !Array.isArray(overrides[key])
        && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = deepMerge(base[key], overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

function getMergedProfile() {
  const overrides = loadOverrides();
  const merged = deepMerge(PROFILE, overrides);

  // Build portalLogins from env vars as defaults, then overlay profile overrides
  const envLogins = {};
  if (process.env.SG_EMAIL) {
    envLogins.smartygrants = { email: process.env.SG_EMAIL, password: process.env.SG_PASSWORD || '', label: 'SmartyGrants' };
  }
  if (process.env.CA_USERNAME) {
    envLogins.creative_australia = { email: process.env.CA_USERNAME, password: process.env.CA_PASSWORD || '', label: 'Creative Australia (Fluxx)' };
  }

  merged.portalLogins = deepMerge(envLogins, overrides.portalLogins || {});
  return merged;
}

// GET /api/profile
router.get('/', (req, res) => {
  res.json(getMergedProfile());
});

// PUT /api/profile — merge partial updates into overrides
router.put('/', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Body must be an object' });
  }
  const current = loadOverrides();
  const merged = deepMerge(current, updates);
  saveOverrides(merged);
  res.json(getMergedProfile());
});

// GET /api/snippets
router.get('/snippets', (req, res) => {
  res.json(SNIPPETS);
});

module.exports = router;
