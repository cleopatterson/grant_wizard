const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const WizardOrchestrator = require('../agent/orchestrator');

// One orchestrator instance per server (single-user app)
let orchestrator = new WizardOrchestrator();

const OVERRIDES_PATH = path.join(__dirname, '..', '..', 'data', 'profile-overrides.json');

// Look up credentials: profile overrides first, then env vars
function getPortalCredentials(portalType) {
  let profileLogins = {};
  try {
    if (fs.existsSync(OVERRIDES_PATH)) {
      const overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
      profileLogins = overrides.portalLogins || {};
    }
  } catch (e) {}

  const isFluxx = ['fluxx', 'creative_australia'].includes(portalType);
  const key = isFluxx ? 'creative_australia' : portalType;

  // Check profile first
  if (profileLogins[key] && profileLogins[key].email && profileLogins[key].password) {
    return { email: profileLogins[key].email, password: profileLogins[key].password, isFluxx };
  }

  // Fall back to env vars
  if (isFluxx) {
    return { email: process.env.CA_USERNAME || '', password: process.env.CA_PASSWORD || '', isFluxx };
  }
  if (portalType === 'smartygrants') {
    return { email: process.env.SG_EMAIL || '', password: process.env.SG_PASSWORD || '', isFluxx };
  }

  // Check profile for any other portal type
  if (profileLogins[portalType] && profileLogins[portalType].email) {
    return { email: profileLogins[portalType].email, password: profileLogins[portalType].password || '', isFluxx: false };
  }

  return { email: '', password: '', isFluxx };
}

// GET /api/wizard/state — current wizard state
router.get('/state', (req, res) => {
  res.json(orchestrator.getState());
});

// POST /api/wizard/select — select a grant
router.post('/select', (req, res) => {
  const { grant } = req.body;
  if (!grant) return res.status(400).json({ error: 'grant is required' });
  orchestrator.selectGrant(grant);
  res.json({ success: true, state: orchestrator.getState() });
});

// GET /api/wizard/credentials — check if saved credentials exist
router.get('/credentials', (req, res) => {
  const portalType = req.query.portal || 'smartygrants';
  const { email, password, isFluxx } = getPortalCredentials(portalType);

  res.json({
    hasCredentials: !!(email && password),
    email,
    password,
    portalType,
    isFluxx,
  });
});

// POST /api/wizard/scan — connect and scan form
router.post('/scan', async (req, res) => {
  let { credentials } = req.body;

  // Fall back to profile/env credentials based on portal type
  if (!credentials || !credentials.email) {
    const grant = orchestrator.getState().grant;
    const portalType = grant?.portal_type || grant?.portalType || 'smartygrants';
    const creds = getPortalCredentials(portalType);
    credentials = { email: creds.email, password: creds.password };
  }

  // Set up SSE for real-time progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const onProgress = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  orchestrator.on('progress', onProgress);

  try {
    const fields = await orchestrator.connectAndScan(credentials);
    res.write(`data: ${JSON.stringify({ type: 'done', fields })}\n\n`);
    if (res.flush) res.flush();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    if (res.flush) res.flush();
  }

  orchestrator.removeListener('progress', onProgress);
  res.end();
});

// PUT /api/wizard/field/:id — update a field value
router.put('/field/:id', (req, res) => {
  const fieldId = parseInt(req.params.id, 10);
  const { value, status } = req.body;
  const updated = orchestrator.updateField(fieldId, { value, status });
  if (!updated) return res.status(404).json({ error: 'Field not found' });
  res.json(updated);
});

// POST /api/wizard/generate-all — background generate all long-form fields (SSE)
router.post('/generate-all', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    await orchestrator.generateAllLongFields((fieldId, content, error) => {
      res.write(`data: ${JSON.stringify({ type: 'field_done', fieldId, content, error })}\n\n`);
      if (res.flush) res.flush();
    });
    res.write(`data: ${JSON.stringify({ type: 'all_done' })}\n\n`);
    if (res.flush) res.flush();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    if (res.flush) res.flush();
  }
  res.end();
});

// POST /api/wizard/field/:id/generate — AI generate content for a field
router.post('/field/:id/generate', async (req, res) => {
  const fieldId = parseInt(req.params.id, 10);
  try {
    const updated = await orchestrator.generateFieldContent(fieldId);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/wizard/field/:id/help — generate from help modal answers
router.post('/field/:id/help', async (req, res) => {
  const fieldId = parseInt(req.params.id, 10);
  const { helpAnswers } = req.body;
  if (!helpAnswers) return res.status(400).json({ error: 'helpAnswers required' });
  try {
    const updated = await orchestrator.generateFromHelpAnswers(fieldId, helpAnswers);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/wizard/fill — fill the form via browser
router.post('/fill', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const onProgress = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  orchestrator.on('progress', onProgress);

  try {
    await orchestrator.fillForm();
    res.write(`data: ${JSON.stringify({ type: 'fill_complete' })}\n\n`);
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
  }

  orchestrator.removeListener('progress', onProgress);
  res.end();
});

// POST /api/wizard/reset — reset the wizard
router.post('/reset', async (req, res) => {
  await orchestrator.cleanup();
  orchestrator = new WizardOrchestrator();
  res.json({ success: true });
});

module.exports = router;
