const express = require('express');
const router = express.Router();
const {
  getDb,
  getGrantById,
  getAllGrants,
  getQuestionsForGrant,
  saveQuestions,
  addCustomQuestion,
  updateQuestion,
  deleteQuestion,
  getAnswersForGrant,
  saveAnswer
} = require('../db');
const { fetchGrantQuestions } = require('../agent/questions');
const { streamAnswer } = require('../agent/drafter');

// ─── Background pre-fetch state ───
let prepareState = { status: 'idle', done: 0, total: 0, current: null, errors: [] };

async function prepareAllQuestions() {
  if (prepareState.status === 'running') return;

  const allGrants = getAllGrants();
  // Only fetch for grants that don't have questions yet
  const needsFetch = allGrants.filter(g => getQuestionsForGrant(g.id).length === 0);

  if (needsFetch.length === 0) {
    prepareState = { status: 'done', done: allGrants.length, total: allGrants.length, current: null, errors: [] };
    return;
  }

  const alreadyDone = allGrants.length - needsFetch.length;
  prepareState = { status: 'running', done: alreadyDone, total: allGrants.length, current: null, errors: [] };

  for (const grant of needsFetch) {
    prepareState.current = grant.name;
    try {
      console.log('[workspace] Pre-fetching questions for:', grant.name);
      const rawQuestions = await fetchGrantQuestions(grant);
      saveQuestions(grant.id, rawQuestions);
      console.log('[workspace] Cached', rawQuestions.length, 'questions for:', grant.name);
    } catch (err) {
      console.error('[workspace] Error pre-fetching for', grant.name, ':', err.message);
      prepareState.errors.push(grant.name);
    }
    prepareState.done++;
  }

  prepareState.status = 'done';
  prepareState.current = null;
  console.log('[workspace] Pre-fetch complete:', prepareState.done, '/', prepareState.total);
}

// POST /api/workspace/prepare — start background pre-fetch of all questions
router.post('/prepare', (req, res) => {
  if (prepareState.status === 'running') {
    return res.json(prepareState);
  }
  prepareAllQuestions();
  res.json(prepareState);
});

// GET /api/workspace/prepare-status — check pre-fetch progress
router.get('/prepare-status', (req, res) => {
  res.json(prepareState);
});

// GET /api/workspace/list — list all grants that have workspace data
// (using /list to avoid conflict with /:grantId)
router.get('/list', (req, res) => {
  const rows = getDb().prepare(`
    SELECT q.grant_id, g.name as grant_name, COUNT(q.id) as question_count,
      (SELECT COUNT(*) FROM workspace_answers a WHERE a.grant_id = q.grant_id) as answer_count
    FROM workspace_questions q
    JOIN grants g ON g.id = q.grant_id
    GROUP BY q.grant_id
    ORDER BY q.grant_id DESC
  `).all();
  res.json(rows);
});

// GET /api/workspace/:grantId — load full workspace state
router.get('/:grantId', (req, res) => {
  const grantId = parseInt(req.params.grantId, 10);
  const grant = getGrantById(grantId);
  if (!grant) return res.status(404).json({ error: 'Grant not found' });

  const questions = getQuestionsForGrant(grantId);
  const answers = getAnswersForGrant(grantId);

  res.json({ grant, questions, answers });
});

// POST /api/workspace/:grantId/fetch-questions — fetch via Claude + web search
router.post('/:grantId/fetch-questions', async (req, res) => {
  const grantId = parseInt(req.params.grantId, 10);
  const grant = getGrantById(grantId);
  if (!grant) return res.status(404).json({ error: 'Grant not found' });

  try {
    console.log('[workspace] Fetching questions for grant:', grantId, grant.name);
    const rawQuestions = await fetchGrantQuestions(grant);
    console.log('[workspace] Got', rawQuestions.length, 'questions from Claude');
    const saved = saveQuestions(grantId, rawQuestions);
    console.log('[workspace] Saved', saved.length, 'questions to DB');
    res.json({ questions: saved });
  } catch (error) {
    console.error('[workspace] Error fetching questions:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/workspace/:grantId/questions — add custom question
router.post('/:grantId/questions', (req, res) => {
  const grantId = parseInt(req.params.grantId, 10);
  const { label, text, word_limit, tips } = req.body;
  if (!text) return res.status(400).json({ error: 'Question text is required' });

  const question = addCustomQuestion(grantId, { label, text, word_limit, tips });
  res.json(question);
});

// PUT /api/workspace/questions/:id — edit question
router.put('/questions/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const updated = updateQuestion(id, req.body);
  if (!updated) return res.status(404).json({ error: 'Question not found or no changes' });
  res.json(updated);
});

// DELETE /api/workspace/questions/:id — delete question
router.delete('/questions/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = deleteQuestion(id);
  if (!deleted) return res.status(404).json({ error: 'Question not found' });
  res.json({ success: true });
});

// PUT /api/workspace/:grantId/answers/:questionId — save user-edited answer
router.put('/:grantId/answers/:questionId', (req, res) => {
  const grantId = parseInt(req.params.grantId, 10);
  const questionId = parseInt(req.params.questionId, 10);
  const { answer_text, project_description } = req.body;

  if (answer_text === undefined) {
    return res.status(400).json({ error: 'answer_text is required' });
  }

  const grant = getGrantById(grantId);
  if (!grant) return res.status(404).json({ error: 'Grant not found' });

  const id = saveAnswer({
    question_id: questionId,
    grant_id: grantId,
    project_description: project_description || '',
    answer_text
  });

  res.json({ success: true, id });
});

// POST /api/workspace/:grantId/generate-answer — stream one answer (SSE)
router.post('/:grantId/generate-answer', async (req, res) => {
  const grantId = parseInt(req.params.grantId, 10);
  const { question_id, project_description } = req.body;

  if (!question_id || !project_description) {
    return res.status(400).json({ error: 'question_id and project_description are required' });
  }

  const grant = getGrantById(grantId);
  if (!grant) return res.status(404).json({ error: 'Grant not found' });

  const allQuestions = getQuestionsForGrant(grantId);
  const question = allQuestions.find(q => q.id === parseInt(question_id, 10));
  if (!question) return res.status(404).json({ error: 'Question not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let fullText = '';

  try {
    for await (const chunk of streamAnswer(grant, question, project_description, allQuestions)) {
      fullText += chunk;
      res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk, question_id: question.id })}\n\n`);
    }

    saveAnswer({
      question_id: question.id,
      grant_id: grantId,
      project_description,
      answer_text: fullText
    });

    res.write(`data: ${JSON.stringify({ type: 'done', question_id: question.id, answer_text: fullText })}\n\n`);
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: 'error', question_id: question.id, error: error.message })}\n\n`);
  }

  res.end();
});

// POST /api/workspace/:grantId/generate-all — stream all answers sequentially (SSE)
router.post('/:grantId/generate-all', async (req, res) => {
  const grantId = parseInt(req.params.grantId, 10);
  const { project_description } = req.body;

  if (!project_description) {
    return res.status(400).json({ error: 'project_description is required' });
  }

  const grant = getGrantById(grantId);
  if (!grant) return res.status(404).json({ error: 'Grant not found' });

  const allQuestions = getQuestionsForGrant(grantId);
  if (allQuestions.length === 0) return res.status(400).json({ error: 'No questions to answer' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  for (const question of allQuestions) {
    res.write(`data: ${JSON.stringify({ type: 'start', question_id: question.id })}\n\n`);

    let fullText = '';

    try {
      for await (const chunk of streamAnswer(grant, question, project_description, allQuestions)) {
        fullText += chunk;
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk, question_id: question.id })}\n\n`);
      }

      saveAnswer({
        question_id: question.id,
        grant_id: grantId,
        project_description,
        answer_text: fullText
      });

      res.write(`data: ${JSON.stringify({ type: 'done', question_id: question.id, answer_text: fullText })}\n\n`);
    } catch (error) {
      res.write(`data: ${JSON.stringify({ type: 'error', question_id: question.id, error: error.message })}\n\n`);
    }
  }

  res.write(`data: ${JSON.stringify({ type: 'all_done' })}\n\n`);
  res.end();
});

module.exports = router;
