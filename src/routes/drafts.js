const express = require('express');
const router = express.Router();
const { getGrantById, getAllDrafts, getDraftById, saveDraft, deleteDraft } = require('../db');
const { generateDraft, streamDraft } = require('../agent/drafter');

// GET /api/drafts — list all saved drafts
router.get('/', (req, res) => {
  const drafts = getAllDrafts();
  res.json(drafts);
});

// GET /api/drafts/:id — get a specific draft
router.get('/:id', (req, res) => {
  const draft = getDraftById(parseInt(req.params.id, 10));
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  res.json(draft);
});

// POST /api/drafts/generate — generate and stream a draft via SSE
router.post('/generate', async (req, res) => {
  const { grant_id, project_description, amount_requested, section_type } = req.body;

  if (!grant_id || !project_description) {
    return res.status(400).json({ error: 'grant_id and project_description are required' });
  }

  const grant = getGrantById(parseInt(grant_id, 10));
  if (!grant) {
    return res.status(404).json({ error: 'Grant not found' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let fullText = '';

  try {
    for await (const chunk of streamDraft(grant, project_description, amount_requested, section_type || 'full')) {
      fullText += chunk;
      res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
    }

    // Save draft to database
    const draftId = saveDraft({
      grant_id: parseInt(grant_id, 10),
      project_description,
      amount_requested: amount_requested || null,
      section_type: section_type || 'full',
      draft_text: fullText
    });

    res.write(`data: ${JSON.stringify({ type: 'done', draft_id: draftId })}\n\n`);
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
  }

  res.end();
});

// DELETE /api/drafts/:id — delete a draft
router.delete('/:id', (req, res) => {
  const deleted = deleteDraft(parseInt(req.params.id, 10));
  if (!deleted) return res.status(404).json({ error: 'Draft not found' });
  res.json({ success: true });
});

module.exports = router;
