const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { query } = require('../database');
const decisionLog = require('../services/decisionLog');
const { appendOwnerDecisionToContextDoc } = require('../services/contextDocAppender');

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
router.get('/escalations', async (req, res) => {
  const projectId = req.query.project_id;
  if (!projectId) return res.status(400).json({ error: 'project_id is required' });
  try {
    const result = await query(
      `SELECT id, project_id, planning_session_id, asking_session_id, question,
              escalation_recommendation, escalation_reason, escalation_context,
              working_files, status, asked_at
       FROM planning_questions
       WHERE project_id = $1 AND status = 'escalated'
       ORDER BY asked_at DESC`,
      [projectId]
    );
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

// POST /api/planning/escalations/:id/answer
// Body: { answer: string, addToContextDoc?: 'PRODUCT.md' | 'ARCHITECTURE.md' | 'neither' }
router.post('/escalations/:id/answer', async (req, res) => {
  const { id } = req.params;
  const { answer, addToContextDoc } = req.body || {};
  if (!answer || !String(answer).trim()) {
    return res.status(400).json({ error: 'answer is required' });
  }

  try {
    const lookup = await query(
      `SELECT pq.id, pq.project_id, pq.planning_session_id, pq.asking_session_id,
              pq.question, pq.working_files,
              p.root_path, p.name AS project_name
       FROM planning_questions pq
       JOIN projects p ON pq.project_id = p.id
       WHERE pq.id = $1 AND pq.status = 'escalated'`,
      [id]
    );
    if (lookup.rows.length === 0) {
      return res.status(404).json({ error: 'Escalation not found or already resolved' });
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
      [answer, id]
    );

    // Log to docs/decisions.md as an owner decision.
    try {
      const decisionsPath = decisionLog.resolveDecisionFilePath(row.root_path);
      await decisionLog.appendDecision(decisionsPath, {
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
      });
      await query('UPDATE planning_questions SET logged_to_file = 1 WHERE id = $1', [id]);
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

    res.json({ status: 'answered', contextDocAppended });
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
    res.json({ status: 'dismissed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
