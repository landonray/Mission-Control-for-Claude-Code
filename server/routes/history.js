const express = require('express');
const router = express.Router();
const { getDb } = require('../database');

// Get session history with summaries
router.get('/sessions', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const search = req.query.search;

  let query, countQuery, params, countParams;

  if (search) {
    query = `
      SELECT s.*, ss.summary
      FROM sessions s
      LEFT JOIN session_summaries ss ON s.id = ss.session_id
      WHERE s.name LIKE ? OR ss.summary LIKE ?
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `;
    const searchTerm = `%${search}%`;
    params = [searchTerm, searchTerm, limit, offset];

    countQuery = `
      SELECT COUNT(DISTINCT s.id) as count
      FROM sessions s
      LEFT JOIN session_summaries ss ON s.id = ss.session_id
      WHERE s.name LIKE ? OR ss.summary LIKE ?
    `;
    countParams = [searchTerm, searchTerm];
  } else {
    query = `
      SELECT s.*, ss.summary
      FROM sessions s
      LEFT JOIN session_summaries ss ON s.id = ss.session_id
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `;
    params = [limit, offset];

    countQuery = 'SELECT COUNT(*) as count FROM sessions';
    countParams = [];
  }

  const sessions = db.prepare(query).all(...params);
  const total = db.prepare(countQuery).get(...countParams);

  res.json({
    sessions,
    total: total.count,
    limit,
    offset
  });
});

// Get full conversation log for a session
router.get('/sessions/:id/log', (req, res) => {
  const db = getDb();
  const messages = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `).all(req.params.id);

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({ session, messages });
});

// Search message content across all sessions
router.get('/search', (req, res) => {
  const db = getDb();
  const query = req.query.q;
  const limit = parseInt(req.query.limit) || 50;

  if (!query) {
    return res.status(400).json({ error: 'q query parameter required' });
  }

  const results = db.prepare(`
    SELECT m.*, s.name as session_name
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    WHERE m.content LIKE ?
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(`%${query}%`, limit);

  res.json(results);
});

// Get daily digests
router.get('/digests', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 30;

  const digests = db.prepare(`
    SELECT * FROM daily_digests
    ORDER BY date DESC
    LIMIT ?
  `).all(limit);

  res.json(digests);
});

// Generate daily digest for a specific date
router.post('/digests/generate', (req, res) => {
  const db = getDb();
  const date = req.body.date || new Date().toISOString().split('T')[0];

  const sessions = db.prepare(`
    SELECT s.*, ss.summary
    FROM sessions s
    LEFT JOIN session_summaries ss ON s.id = ss.session_id
    WHERE DATE(s.created_at) = ? OR DATE(s.last_activity_at) = ?
    ORDER BY s.created_at ASC
  `).all(date, date);

  if (sessions.length === 0) {
    return res.json({ message: 'No sessions found for this date' });
  }

  const content = sessions.map(s => {
    return `- ${s.name}: ${s.summary || `${s.user_message_count} messages, status: ${s.status}`}`;
  }).join('\n');

  const digest = `Daily Digest for ${date}\n\nSessions: ${sessions.length}\n\n${content}`;

  try {
    db.prepare(`
      INSERT OR REPLACE INTO daily_digests (date, content, session_count, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(date, digest, sessions.length);

    res.json({ date, content: digest, session_count: sessions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-generate session summary (called by SessionEnd hook)
router.post('/auto-summary', (req, res) => {
  const db = getDb();
  const { session_id, branch, files_changed } = req.body;

  if (!session_id) {
    return res.status(400).json({ error: 'session_id required' });
  }

  // Get session info
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session_id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Build summary from available data
  const messageCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(session_id);
  const summary = `Session "${session.name}" ended. Branch: ${branch || session.branch || 'unknown'}. Messages: ${messageCount.count}. Files changed: ${files_changed || 0}.`;

  try {
    // Check if summary already exists
    const existing = db.prepare('SELECT id FROM session_summaries WHERE session_id = ?').get(session_id);
    if (existing) {
      db.prepare('UPDATE session_summaries SET summary = ?, created_at = datetime(\'now\') WHERE session_id = ?').run(summary, session_id);
    } else {
      db.prepare(`
        INSERT INTO session_summaries (session_id, summary, key_actions, files_modified, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(session_id, summary, null, files_changed ? String(files_changed) : null);
    }
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
