const express = require('express');
const router = express.Router();
const { query } = require('../database');

// Get session history with summaries
router.get('/sessions', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const search = req.query.search;

  let sql, countQuery, params, countParams;

  if (search) {
    sql = `
      SELECT s.*, ss.summary
      FROM sessions s
      LEFT JOIN session_summaries ss ON s.id = ss.session_id
      WHERE s.name LIKE $1 OR ss.summary LIKE $2
      ORDER BY s.created_at DESC
      LIMIT $3 OFFSET $4
    `;
    const searchTerm = `%${search}%`;
    params = [searchTerm, searchTerm, limit, offset];

    countQuery = `
      SELECT COUNT(DISTINCT s.id) as count
      FROM sessions s
      LEFT JOIN session_summaries ss ON s.id = ss.session_id
      WHERE s.name LIKE $1 OR ss.summary LIKE $2
    `;
    countParams = [searchTerm, searchTerm];
  } else {
    sql = `
      SELECT s.*, ss.summary
      FROM sessions s
      LEFT JOIN session_summaries ss ON s.id = ss.session_id
      ORDER BY s.created_at DESC
      LIMIT $1 OFFSET $2
    `;
    params = [limit, offset];

    countQuery = 'SELECT COUNT(*) as count FROM sessions';
    countParams = [];
  }

  const sessions = (await query(sql, params)).rows;
  const total = (await query(countQuery, countParams)).rows[0];

  res.json({
    sessions,
    total: total.count,
    limit,
    offset
  });
});

// Get full conversation log for a session
router.get('/sessions/:id/log', async (req, res) => {
  const messages = (await query(`
    SELECT * FROM messages
    WHERE session_id = $1
    ORDER BY timestamp ASC
  `, [req.params.id])).rows;

  const session = (await query('SELECT * FROM sessions WHERE id = $1', [req.params.id])).rows[0];

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({ session, messages });
});

// Search message content across all sessions
router.get('/search', async (req, res) => {
  const q = req.query.q;
  const limit = parseInt(req.query.limit) || 50;

  if (!q) {
    return res.status(400).json({ error: 'q query parameter required' });
  }

  const results = (await query(`
    SELECT m.*, s.name as session_name
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    WHERE m.content LIKE $1
    ORDER BY m.timestamp DESC
    LIMIT $2
  `, [`%${q}%`, limit])).rows;

  res.json(results);
});

// Get daily digests
router.get('/digests', async (req, res) => {
  const limit = parseInt(req.query.limit) || 30;

  const digests = (await query(`
    SELECT * FROM daily_digests
    ORDER BY date DESC
    LIMIT $1
  `, [limit])).rows;

  res.json(digests);
});

// Generate daily digest for a specific date
router.post('/digests/generate', async (req, res) => {
  const date = req.body.date || new Date().toISOString().split('T')[0];

  const sessions = (await query(`
    SELECT s.*, ss.summary
    FROM sessions s
    LEFT JOIN session_summaries ss ON s.id = ss.session_id
    WHERE DATE(s.created_at) = $1 OR DATE(s.last_activity_at) = $2
    ORDER BY s.created_at ASC
  `, [date, date])).rows;

  if (sessions.length === 0) {
    return res.json({ message: 'No sessions found for this date' });
  }

  const content = sessions.map(s => {
    return `- ${s.name}: ${s.summary || `${s.user_message_count} messages, status: ${s.status}`}`;
  }).join('\n');

  const digest = `Daily Digest for ${date}\n\nSessions: ${sessions.length}\n\n${content}`;

  try {
    await query(`
      INSERT INTO daily_digests (date, content, session_count, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (date) DO UPDATE SET content = EXCLUDED.content, session_count = EXCLUDED.session_count, created_at = NOW()
    `, [date, digest, sessions.length]);

    res.json({ date, content: digest, session_count: sessions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-generate session summary (called by SessionEnd hook)
router.post('/auto-summary', async (req, res) => {
  const { session_id, branch, files_changed } = req.body;

  if (!session_id) {
    return res.status(400).json({ error: 'session_id required' });
  }

  const session = (await query('SELECT * FROM sessions WHERE id = $1', [session_id])).rows[0];
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const messageCount = (await query('SELECT COUNT(*) as count FROM messages WHERE session_id = $1', [session_id])).rows[0];
  const summary = `Session "${session.name}" ended. Branch: ${branch || session.branch || 'unknown'}. Messages: ${messageCount.count}. Files changed: ${files_changed || 0}.`;

  try {
    const existing = (await query('SELECT id FROM session_summaries WHERE session_id = $1', [session_id])).rows[0];
    if (existing) {
      await query('UPDATE session_summaries SET summary = $1, created_at = NOW() WHERE session_id = $2', [summary, session_id]);
    } else {
      await query(`
        INSERT INTO session_summaries (session_id, summary, key_actions, files_modified, created_at)
        VALUES ($1, $2, $3, $4, NOW())
      `, [session_id, summary, null, files_changed ? String(files_changed) : null]);
    }
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
