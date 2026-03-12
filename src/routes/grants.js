const express = require('express');
const router = express.Router();
const { getAllGrants, getGrantById } = require('../db');
const { researchGrants, getResearchStatus } = require('../agent/researcher');

// GET /api/grants — list grants with optional filters
router.get('/', (req, res) => {
  const { type, sort } = req.query;
  const grants = getAllGrants({ type, sort });
  res.json(grants);
});

// GET /api/grants/research/status — check if research is running
router.get('/research/status', (req, res) => {
  res.json(getResearchStatus());
});

// GET /api/grants/:id — single grant
router.get('/:id', (req, res) => {
  const grant = getGrantById(parseInt(req.params.id, 10));
  if (!grant) return res.status(404).json({ error: 'Grant not found' });
  res.json(grant);
});

// POST /api/grants/research — trigger grant research
router.post('/research', async (req, res) => {
  try {
    const status = getResearchStatus();
    if (status.status === 'running') {
      return res.json({ status: 'already_running' });
    }

    // Start research in background, respond immediately
    res.json({ status: 'started' });

    // Run research (will update status internally)
    researchGrants().catch(err => {
      console.error('Research error:', err.message);
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
