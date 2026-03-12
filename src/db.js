const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const SEED_GRANTS = require('./data/seed-grants');

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'grants.db');

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    init();
  }
  return db;
}

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      body TEXT,
      amount TEXT,
      type TEXT,
      url TEXT,
      description TEXT,
      eligibility TEXT,
      tips TEXT,
      tags TEXT,
      status TEXT,
      deadline_date TEXT,
      relevance_score INTEGER DEFAULT 0,
      source TEXT DEFAULT 'curated',
      discovered_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grant_id INTEGER REFERENCES grants(id),
      project_description TEXT,
      amount_requested TEXT,
      section_type TEXT,
      draft_text TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS research_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT,
      grants_found INTEGER DEFAULT 0,
      ran_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspace_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grant_id INTEGER REFERENCES grants(id),
      question_label TEXT,
      question_text TEXT NOT NULL,
      word_limit INTEGER,
      tips TEXT,
      sort_order INTEGER DEFAULT 0,
      is_custom INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS workspace_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER REFERENCES workspace_questions(id) ON DELETE CASCADE,
      grant_id INTEGER REFERENCES grants(id),
      project_description TEXT,
      answer_text TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Add portal columns if missing
  const cols = db.prepare("PRAGMA table_info(grants)").all().map(c => c.name);
  if (!cols.includes('portal_type')) {
    db.prepare("ALTER TABLE grants ADD COLUMN portal_type TEXT DEFAULT 'smartygrants'").run();
  }
  if (!cols.includes('login_url')) {
    db.prepare("ALTER TABLE grants ADD COLUMN login_url TEXT").run();
  }
  if (!cols.includes('application_url')) {
    db.prepare("ALTER TABLE grants ADD COLUMN application_url TEXT").run();
  }

  // Seed grants if table is empty
  const count = db.prepare('SELECT COUNT(*) as c FROM grants').get().c;
  if (count === 0) {
    const insert = db.prepare(`
      INSERT INTO grants (name, body, amount, type, url, description, eligibility, tips, tags, status, deadline_date, relevance_score, source)
      VALUES (@name, @body, @amount, @type, @url, @description, @eligibility, @tips, @tags, @status, @deadline_date, @relevance_score, 'curated')
    `);

    const tx = db.transaction(() => {
      for (const grant of SEED_GRANTS) {
        insert.run({
          ...grant,
          tags: JSON.stringify(grant.tags)
        });
      }
    });
    tx();
    console.log(`Seeded ${SEED_GRANTS.length} grants into database`);
  }

  // Set known application URLs
  db.prepare("UPDATE grants SET application_url = ?, login_url = ? WHERE name LIKE '%Touring & Travel%' AND application_url IS NULL")
    .run('https://soundnsw.smartygrants.com.au/form/15030850/continue/1', 'https://soundnsw.smartygrants.com.au');


  // Creative Australia / Music Australia — Fluxx portal
  db.prepare("UPDATE grants SET login_url = ?, portal_type = ? WHERE name LIKE '%Music Australia%Export%'")
    .run('https://australiacouncil.fluxx.io/user_sessions/new', 'fluxx');
  db.prepare("UPDATE grants SET login_url = ?, portal_type = ? WHERE name LIKE '%Creative Australia%Arts Projects%'")
    .run('https://australiacouncil.fluxx.io/user_sessions/new', 'fluxx');
  db.prepare("UPDATE grants SET login_url = ?, portal_type = ? WHERE name LIKE '%Music Australia%Marketing%'")
    .run('https://australiacouncil.fluxx.io/user_sessions/new', 'fluxx');

  // Set correct portal types
  const portalUpdates = [
    { match: '%Creative Australia%', portal: 'creative_australia' },
    { match: '%Music Australia%Export%', portal: 'creative_australia' },
    { match: '%Music Australia%Marketing%', portal: 'creative_australia' },
    { match: '%APRA AMCOS%Professional%', portal: 'apra_amcos' },
    { match: '%APRA AMCOS%Global%', portal: 'apra_amcos' },
    { match: '%American Australian%', portal: 'aaa' },
    { match: '%Austrade%', portal: 'austrade' },
    { match: '%Create NSW%', portal: 'create_nsw' },
    { match: '%Regional Arts%', portal: 'regional_arts' },
    { match: '%Sound NSW%', portal: 'smartygrants' },
  ];
  for (const { match, portal } of portalUpdates) {
    db.prepare("UPDATE grants SET portal_type = ? WHERE name LIKE ?").run(portal, match);
  }
}

// --- Grant helpers ---

function getAllGrants({ type, sort } = {}) {
  let sql = 'SELECT * FROM grants WHERE 1=1';
  const params = [];

  if (type && type !== 'all') {
    sql += ' AND type = ?';
    params.push(type);
  }

  if (sort === 'deadline') {
    sql += ' ORDER BY CASE WHEN deadline_date IS NULL THEN 1 ELSE 0 END, deadline_date ASC';
  } else if (sort === 'relevance') {
    sql += ' ORDER BY relevance_score DESC';
  } else {
    sql += ' ORDER BY relevance_score DESC';
  }

  return getDb().prepare(sql).all(...params).map(parseGrant);
}

function getGrantById(id) {
  const row = getDb().prepare('SELECT * FROM grants WHERE id = ?').get(id);
  return row ? parseGrant(row) : null;
}

function upsertGrant(grant) {
  const existing = getDb().prepare('SELECT id FROM grants WHERE name = ? AND body = ?').get(grant.name, grant.body);

  if (existing) {
    getDb().prepare(`
      UPDATE grants SET amount = ?, url = ?, description = ?, eligibility = ?, tips = ?, tags = ?,
        status = ?, deadline_date = ?, relevance_score = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(grant.amount, grant.url, grant.description, grant.eligibility, grant.tips,
      JSON.stringify(grant.tags || []), grant.status, grant.deadline_date || null,
      grant.relevance_score || 0, existing.id);
    return existing.id;
  }

  const result = getDb().prepare(`
    INSERT INTO grants (name, body, amount, type, url, description, eligibility, tips, tags, status, deadline_date, relevance_score, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(grant.name, grant.body, grant.amount, grant.type, grant.url, grant.description,
    grant.eligibility, grant.tips, JSON.stringify(grant.tags || []), grant.status,
    grant.deadline_date || null, grant.relevance_score || 0, 'discovered');
  return result.lastInsertRowid;
}

function parseGrant(row) {
  try {
    row.tags = JSON.parse(row.tags || '[]');
  } catch {
    row.tags = [];
  }
  return row;
}

// --- Draft helpers ---

function getAllDrafts() {
  return getDb().prepare(`
    SELECT d.*, g.name as grant_name FROM drafts d
    LEFT JOIN grants g ON d.grant_id = g.id
    ORDER BY d.created_at DESC
  `).all();
}

function getDraftById(id) {
  return getDb().prepare(`
    SELECT d.*, g.name as grant_name FROM drafts d
    LEFT JOIN grants g ON d.grant_id = g.id
    WHERE d.id = ?
  `).get(id);
}

function saveDraft({ grant_id, project_description, amount_requested, section_type, draft_text }) {
  const result = getDb().prepare(`
    INSERT INTO drafts (grant_id, project_description, amount_requested, section_type, draft_text)
    VALUES (?, ?, ?, ?, ?)
  `).run(grant_id, project_description, amount_requested, section_type, draft_text);
  return result.lastInsertRowid;
}

function deleteDraft(id) {
  return getDb().prepare('DELETE FROM drafts WHERE id = ?').run(id).changes > 0;
}

// --- Research run helpers ---

function logResearchRun(query, grantsFound) {
  getDb().prepare('INSERT INTO research_runs (query, grants_found) VALUES (?, ?)').run(query, grantsFound);
}

// --- Workspace question helpers ---

function getQuestionsForGrant(grantId) {
  return getDb().prepare('SELECT * FROM workspace_questions WHERE grant_id = ? ORDER BY sort_order ASC').all(grantId);
}

function saveQuestions(grantId, questions) {
  const db = getDb();
  const del = db.prepare('DELETE FROM workspace_questions WHERE grant_id = ? AND is_custom = 0');
  const insert = db.prepare(`
    INSERT INTO workspace_questions (grant_id, question_label, question_text, word_limit, tips, sort_order, is_custom)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `);

  const tx = db.transaction(() => {
    del.run(grantId);
    questions.forEach((q, i) => {
      insert.run(grantId, q.label || null, q.text, q.word_limit || null, q.tips || null, i);
    });
  });
  tx();

  return getQuestionsForGrant(grantId);
}

function addCustomQuestion(grantId, { label, text, word_limit, tips }) {
  const maxOrder = getDb().prepare('SELECT MAX(sort_order) as m FROM workspace_questions WHERE grant_id = ?').get(grantId);
  const nextOrder = (maxOrder?.m ?? -1) + 1;
  const result = getDb().prepare(`
    INSERT INTO workspace_questions (grant_id, question_label, question_text, word_limit, tips, sort_order, is_custom)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(grantId, label || null, text, word_limit || null, tips || null, nextOrder);
  return getDb().prepare('SELECT * FROM workspace_questions WHERE id = ?').get(result.lastInsertRowid);
}

function updateQuestion(id, fields) {
  const sets = [];
  const params = [];
  if (fields.label !== undefined) { sets.push('question_label = ?'); params.push(fields.label); }
  if (fields.text !== undefined) { sets.push('question_text = ?'); params.push(fields.text); }
  if (fields.word_limit !== undefined) { sets.push('word_limit = ?'); params.push(fields.word_limit); }
  if (fields.tips !== undefined) { sets.push('tips = ?'); params.push(fields.tips); }
  if (sets.length === 0) return null;
  params.push(id);
  getDb().prepare(`UPDATE workspace_questions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getDb().prepare('SELECT * FROM workspace_questions WHERE id = ?').get(id);
}

function deleteQuestion(id) {
  return getDb().prepare('DELETE FROM workspace_questions WHERE id = ?').run(id).changes > 0;
}

// --- Workspace answer helpers ---

function getAnswersForGrant(grantId) {
  return getDb().prepare('SELECT * FROM workspace_answers WHERE grant_id = ? ORDER BY id ASC').all(grantId);
}

function saveAnswer({ question_id, grant_id, project_description, answer_text }) {
  const existing = getDb().prepare('SELECT id FROM workspace_answers WHERE question_id = ? AND grant_id = ?').get(question_id, grant_id);
  if (existing) {
    getDb().prepare(`UPDATE workspace_answers SET answer_text = ?, project_description = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(answer_text, project_description, existing.id);
    return existing.id;
  }
  const result = getDb().prepare(`
    INSERT INTO workspace_answers (question_id, grant_id, project_description, answer_text)
    VALUES (?, ?, ?, ?)
  `).run(question_id, grant_id, project_description, answer_text);
  return result.lastInsertRowid;
}

module.exports = {
  getDb,
  getAllGrants,
  getGrantById,
  upsertGrant,
  getAllDrafts,
  getDraftById,
  saveDraft,
  deleteDraft,
  logResearchRun,
  getQuestionsForGrant,
  saveQuestions,
  addCustomQuestion,
  updateQuestion,
  deleteQuestion,
  getAnswersForGrant,
  saveAnswer
};
