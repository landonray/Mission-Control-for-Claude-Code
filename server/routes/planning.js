const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { query } = require('../database');
const decisionLog = require('../services/decisionLog');
const { appendOwnerDecisionToContextDoc } = require('../services/contextDocAppender');

function broadcastDecisionsChanged(payload) {
  try {
    const websocket = require('../websocket');
    websocket.broadcastToAll({ type: 'decisions_changed', source: 'planning', ...payload });
  } catch { /* websocket may not be initialized in tests */ }
}

// decisionChat is ESM — use lazy dynamic import
// Some runtimes (e.g. tsx) wrap ESM named exports under .default when imported from CJS
function unwrapDefault(mod) {
  if (!mod) return mod;
  // If named exports exist on top level, prefer that. Otherwise unwrap default.
  if (typeof mod.buildSystemPrompt === 'function') return mod;
  if (mod.default && typeof mod.default === 'object') return mod.default;
  return mod;
}

let _decisionChat;
async function getDecisionChat() {
  if (!_decisionChat) {
    _decisionChat = unwrapDefault(await import('../services/decisionChat.js'));
  }
  return _decisionChat;
}

async function loadProjectDocs(projectId) {
  const result = await query(`SELECT root_path FROM projects WHERE id = $1`, [projectId]);
  const projectPath = result.rows[0]?.root_path;
  const read = (filename) => {
    if (!projectPath) return '';
    const fp = path.join(projectPath, 'docs', filename);
    try {
      return fs.readFileSync(fp, 'utf8');
    } catch {
      return '';
    }
  };
  return {
    productMd: read('PRODUCT.md'),
    architectureMd: read('ARCHITECTURE.md'),
    decisionsMd: read('decisions.md'),
  };
}

async function loadQuestion(id) {
  const result = await query(
    `SELECT * FROM planning_questions WHERE id = $1`, [id]
  );
  return result.rows[0] || null;
}

// GET /api/planning/questions — list planning questions, optionally filtered
//   ?project_id=...   limit by project
//   ?status=pending|answered
//   ?limit=50
router.get('/questions', async (req, res) => {
  try {
    const filters = [];
    const params = [];
    if (req.query.project_id) {
      params.push(req.query.project_id);
      filters.push(`pq.project_id = $${params.length}`);
    }
    if (req.query.status) {
      params.push(req.query.status);
      filters.push(`pq.status = $${params.length}`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    params.push(limit);
    const sql = `
      SELECT pq.id, pq.project_id, pq.planning_session_id, pq.asking_session_id,
             pq.question, pq.answer, pq.working_files, pq.status,
             pq.logged_to_file, pq.asked_at, pq.answered_at,
             p.name AS project_name,
             s.name AS planning_session_name, s.status AS planning_session_status
      FROM planning_questions pq
      LEFT JOIN projects p ON p.id = pq.project_id
      LEFT JOIN sessions s ON s.id = pq.planning_session_id
      ${where}
      ORDER BY pq.asked_at DESC
      LIMIT $${params.length}`;
    const rows = (await query(sql, params)).rows;
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/planning/questions/:id
router.get('/questions/:id', async (req, res) => {
  try {
    const row = (await query(
      `SELECT pq.*, p.name AS project_name, s.name AS planning_session_name, s.status AS planning_session_status
       FROM planning_questions pq
       LEFT JOIN projects p ON p.id = pq.project_id
       LEFT JOIN sessions s ON s.id = pq.planning_session_id
       WHERE pq.id = $1`,
      [req.params.id]
    )).rows[0];
    if (!row) return res.status(404).json({ error: 'Planning question not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/planning/usage?project_id=...&window=7d|30d|all
// Returns per-session-type counts and durations for planning, extraction,
// and eval_gatherer sessions. Replaces the old rate-limit cap with passive
// observability — owners can see usage patterns and decide if they care.
router.get('/usage', async (req, res) => {
  const projectId = req.query.project_id;
  const windowKey = req.query.window || '7d';
  if (!projectId) return res.status(400).json({ error: 'project_id is required' });

  const intervalSql = windowKey === '30d'
    ? `AND created_at > NOW() - INTERVAL '30 days'`
    : windowKey === 'all'
      ? ''
      : `AND created_at > NOW() - INTERVAL '7 days'`;

  try {
    const result = await query(
      `SELECT
         session_type,
         COUNT(*) AS session_count,
         COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at::timestamp, NOW()) - created_at::timestamp))), 0) AS total_duration_seconds,
         COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(ended_at::timestamp, NOW()) - created_at::timestamp))), 0) AS avg_duration_seconds
       FROM sessions
       WHERE project_id = $1
         AND session_type IN ('planning', 'extraction', 'eval_gatherer')
         ${intervalSql}
       GROUP BY session_type
       ORDER BY session_type`,
      [projectId]
    );
    res.json({
      window: windowKey,
      stats: result.rows.map((r) => ({
        session_type: r.session_type,
        session_count: Number(r.session_count) || 0,
        total_duration_seconds: Math.round(Number(r.total_duration_seconds) || 0),
        avg_duration_seconds: Math.round(Number(r.avg_duration_seconds) || 0),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/planning/decisions/:projectId — read parsed entries from
// docs/decisions.md, useful for UI display and slice 3 testing.
router.get('/decisions/:projectId', async (req, res) => {
  try {
    const project = (await query('SELECT id, root_path FROM projects WHERE id = $1', [req.params.projectId])).rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const filePath = decisionLog.resolveDecisionFilePath(project.root_path);
    if (!fs.existsSync(filePath)) return res.json({ path: filePath, exists: false, entries: [] });
    const content = await fs.promises.readFile(filePath, 'utf8');
    const entries = decisionLog.parseDecisions(content);
    res.json({ path: filePath, exists: true, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/planning/escalations?project_id=...
// project_id is optional — omit to get escalations across all projects
router.get('/escalations', async (req, res) => {
  const projectId = req.query.project_id;
  try {
    const baseSelect = `
      SELECT pq.id, pq.project_id, pq.planning_session_id, pq.asking_session_id, pq.question,
             pq.escalation_recommendation, pq.escalation_reason, pq.escalation_context,
             pq.working_files, pq.status, pq.asked_at,
             p.name AS project_name
      FROM planning_questions pq
      LEFT JOIN projects p ON p.id = pq.project_id
      WHERE pq.status = 'escalated'`;

    const result = projectId
      ? await query(`${baseSelect} AND pq.project_id = $1 ORDER BY pq.asked_at DESC`, [projectId])
      : await query(`${baseSelect} ORDER BY pq.asked_at ASC`);

    res.json(result.rows.map((r) => ({
      ...r,
      working_files: r.working_files
        ? r.working_files.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/planning/escalations/count
// Returns total count of pending escalated decisions across all projects
router.get('/escalations/count', async (req, res) => {
  try {
    const result = await query(
      `SELECT COUNT(*)::int AS count FROM planning_questions WHERE status = 'escalated'`
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared helper: applies the owner's answer to an escalated question.
// Used by both the legacy /answer route and the new /finalize route.
// Returns { status: 'answered', contextDocAppended }.
// Throws if the question isn't in 'escalated' state or doesn't exist.
async function applyOwnerAnswer({ questionId, answer, reasoning_summary, addToContextDoc }) {
  const lookup = await query(
    `SELECT pq.id, pq.project_id, pq.planning_session_id, pq.asking_session_id,
            pq.question, pq.working_files,
            p.root_path, p.name AS project_name
     FROM planning_questions pq
     JOIN projects p ON pq.project_id = p.id
     WHERE pq.id = $1 AND pq.status = 'escalated'`,
    [questionId]
  );
  if (lookup.rows.length === 0) {
    const err = new Error('Escalation not found or already resolved');
    err.statusCode = 404;
    throw err;
  }
  const row = lookup.rows[0];

  await query(
    `UPDATE planning_questions
       SET status = 'answered',
           owner_answer = $1,
           owner_answered_at = NOW(),
           answered_at = NOW(),
           decided_by = 'owner'
     WHERE id = $2`,
    [answer, questionId]
  );

  // Log to docs/decisions.md as an owner decision.
  try {
    const decisionsPath = decisionLog.resolveDecisionFilePath(row.root_path);
    const entry = {
      timestamp: new Date().toISOString(),
      askingSessionId: row.asking_session_id || 'unknown',
      planningSessionId: row.planning_session_id,
      workingFiles: row.working_files
        ? row.working_files.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
      projectName: row.project_name,
      question: row.question,
      answer,
      decidedBy: 'owner',
    };
    if (reasoning_summary && reasoning_summary.trim()) {
      entry.reasoning = reasoning_summary.trim();
    }
    await decisionLog.appendDecision(decisionsPath, entry);
    await query('UPDATE planning_questions SET logged_to_file = 1 WHERE id = $1', [questionId]);
  } catch (e) {
    console.error('[escalations] Failed to append decision log:', e.message);
  }

  // Optionally append to PRODUCT.md or ARCHITECTURE.md.
  let contextDocAppended = null;
  if (addToContextDoc && addToContextDoc !== 'neither') {
    try {
      const result = await appendOwnerDecisionToContextDoc({
        projectRoot: row.root_path,
        doc: addToContextDoc,
        question: row.question,
        answer,
        timestamp: new Date().toISOString(),
      });
      contextDocAppended = result.path;
    } catch (e) {
      console.error('[escalations] Failed to append context doc:', e.message);
    }
  }

  return { status: 'answered', contextDocAppended };
}

// POST /api/planning/escalations/:id/answer
// Body: { answer: string, addToContextDoc?: 'PRODUCT.md' | 'ARCHITECTURE.md' | 'neither' }
router.post('/escalations/:id/answer', async (req, res) => {
  const { id } = req.params;
  const { answer, addToContextDoc } = req.body || {};
  if (!answer || !String(answer).trim()) {
    return res.status(400).json({ error: 'answer is required' });
  }

  try {
    const result = await applyOwnerAnswer({
      questionId: id,
      answer,
      reasoning_summary: '',
      addToContextDoc,
    });
    broadcastDecisionsChanged({ questionId: id });
    res.json(result);
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/planning/escalations/:id/chat
// Returns chat history for an escalated question, oldest first.
router.get('/escalations/:id/chat', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, role, content, created_at FROM decision_chats
       WHERE question_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/planning/escalations/:id/chat
// Body: { message: string }
// Appends the user message, runs an LLM turn with project-doc context,
// stores the assistant reply, and returns both messages.
router.post('/escalations/:id/chat', async (req, res) => {
  const { message } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  try {
    const question = await loadQuestion(req.params.id);
    if (!question) return res.status(404).json({ error: 'not found' });
    if (question.status !== 'escalated') {
      return res.status(409).json({ error: 'question is not in escalated state' });
    }

    const userId = randomUUID();
    await query(
      `INSERT INTO decision_chats (id, question_id, role, content, created_at)
       VALUES ($1, $2, 'user', $3, NOW())`,
      [userId, req.params.id, message.trim()]
    );

    const history = await query(
      `SELECT role, content FROM decision_chats WHERE question_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );

    const docs = await loadProjectDocs(question.project_id);
    const { buildSystemPrompt, sendChatTurn } = await getDecisionChat();
    const systemPrompt = buildSystemPrompt(
      { ...question, working_files: question.working_files ? question.working_files.split(',').map((s) => s.trim()) : [] },
      docs
    );
    const reply = await sendChatTurn({
      systemPrompt,
      messages: history.rows,
    });

    const assistantId = randomUUID();
    await query(
      `INSERT INTO decision_chats (id, question_id, role, content, created_at)
       VALUES ($1, $2, 'assistant', $3, NOW())`,
      [assistantId, req.params.id, reply]
    );

    res.json({
      user: { id: userId, role: 'user', content: message.trim() },
      assistant: { id: assistantId, role: 'assistant', content: reply },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/planning/escalations/:id/dismiss
router.post('/escalations/:id/dismiss', async (req, res) => {
  const { id } = req.params;
  try {
    await query(
      `UPDATE planning_questions
         SET status = 'dismissed', dismissed_at = NOW()
       WHERE id = $1`,
      [id]
    );
    broadcastDecisionsChanged({ questionId: id });
    res.json({ status: 'dismissed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/planning/escalations/:id/draft-answer
// Asks the LLM to summarize the chat into { answer, reasoning_summary }.
router.post('/escalations/:id/draft-answer', async (req, res) => {
  try {
    const question = await loadQuestion(req.params.id);
    if (!question) return res.status(404).json({ error: 'not found' });
    if (question.status !== 'escalated') {
      return res.status(409).json({ error: 'question is not escalated' });
    }
    const history = await query(
      `SELECT role, content FROM decision_chats WHERE question_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    const docs = await loadProjectDocs(question.project_id);
    const { buildSystemPrompt, draftFinalAnswer } = await getDecisionChat();
    const systemPrompt = buildSystemPrompt(
      { ...question, working_files: question.working_files ? question.working_files.split(',').map((s) => s.trim()) : [] },
      docs
    );
    const drafted = await draftFinalAnswer({ systemPrompt, messages: history.rows });
    res.json(drafted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/planning/escalations/:id/finalize
// Body: { answer: string, reasoning_summary?: string, addToContextDoc?: 'PRODUCT.md' | 'ARCHITECTURE.md' | 'neither' }
router.post('/escalations/:id/finalize', async (req, res) => {
  const { answer, reasoning_summary, addToContextDoc } = req.body || {};
  if (!answer || !String(answer).trim()) {
    return res.status(400).json({ error: 'answer is required' });
  }
  try {
    const question = await loadQuestion(req.params.id);
    if (!question) return res.status(404).json({ error: 'not found' });
    if (question.status !== 'escalated') {
      return res.status(409).json({ error: 'question is not escalated' });
    }
    const result = await applyOwnerAnswer({
      questionId: req.params.id,
      answer: String(answer).trim(),
      reasoning_summary: (reasoning_summary || '').trim(),
      addToContextDoc: addToContextDoc || 'neither',
    });
    broadcastDecisionsChanged({ questionId: req.params.id });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
