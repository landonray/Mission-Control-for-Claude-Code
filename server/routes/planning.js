const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { query } = require('../database');
const decisionLog = require('../services/decisionLog');

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

module.exports = router;
