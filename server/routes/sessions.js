const express = require('express');
const path = require('path');
const router = express.Router();
const { getDb } = require('../database');
const { createSession, getSession, getAllActiveSessions, endSession, resumeSession } = require('../services/sessionManager');

// List all sessions (active + recent + ended — unified view)
router.get('/', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 50;
  const status = req.query.status;

  let query = 'SELECT * FROM sessions ORDER BY last_activity_at DESC LIMIT ?';
  let params = [limit];

  if (status) {
    query = 'SELECT * FROM sessions WHERE status = ? ORDER BY last_activity_at DESC LIMIT ?';
    params = [status, limit];
  }

  const sessions = db.prepare(query).all(...params);
  const active = getAllActiveSessions();

  // Reconcile stale statuses: if a session shows non-ended in DB
  // but is no longer tracked in memory, mark it as ended.
  // Skip sessions that have a tmux_session_name — they may still be running in tmux.
  const updateStale = db.prepare(
    "UPDATE sessions SET status = 'ended', ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?"
  );
  const activeIds = new Set(active.map(a => a.id));

  const enriched = sessions.map(s => {
    const isStale = s.status !== 'ended' && !activeIds.has(s.id) && !s.tmux_session_name;
    if (isStale) {
      updateStale.run(s.id);
      s.status = 'ended';
    }
    const activeInfo = active.find(a => a.id === s.id);
    const projectName = s.working_directory
      ? path.basename(s.working_directory)
      : 'Ungrouped';
    return {
      ...s,
      project_name: projectName,
      isActive: !!activeInfo,
      pendingPermission: activeInfo?.pendingPermission || null,
      archived: !!s.archived,
      resumable: s.status === 'ended' // All ended sessions are resumable
    };
  });

  res.json(enriched);
});

// Get single session details
router.get('/:id', (req, res) => {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const activeSession = getSession(req.params.id);

  // Reconcile stale status — skip tmux sessions
  if (session.status !== 'ended' && !activeSession && !session.tmux_session_name) {
    db.prepare("UPDATE sessions SET status = 'ended', ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?").run(req.params.id);
    session.status = 'ended';
  }

  session.isActive = !!activeSession;
  session.pendingPermission = activeSession?.pendingPermission || null;
  session.resumable = session.status === 'ended';

  res.json(session);
});

// Create new session
router.post('/', (req, res) => {
  try {
    const { name, workingDirectory, permissionMode, initialPrompt, branch, mcpConnections, useWorktree, model } = req.body;

    const options = {
      name,
      workingDirectory,
      permissionMode,
      initialPrompt,
      branch,
      mcpConnections,
      useWorktree,
      model
    };

    const session = createSession(options);
    res.status(201).json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send message to session (auto-resumes ended sessions)
router.post('/:id/message', (req, res) => {
  let session = getSession(req.params.id);

  if (!session) {
    // Session not in memory — check if it exists in DB for resume
    const db = getDb();
    const dbSession = db.prepare('SELECT id FROM sessions WHERE id = ?').get(req.params.id);
    if (!dbSession) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Resume the session
    try {
      session = resumeSession(req.params.id, req.body.content);
      if (!session) {
        return res.status(500).json({ error: 'Failed to resume session' });
      }
      return res.json({ success: true, resumed: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    session.sendMessage(req.body.content);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Respond to permission request
router.post('/:id/permission', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or not active' });
  }

  session.respondToPermission(req.body.approved);
  res.json({ success: true });
});

// Pause session
router.post('/:id/pause', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or not active' });
  }

  session.pause();
  res.json({ success: true });
});

// Resume session
router.post('/:id/resume', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or not active' });
  }

  session.resume();
  res.json({ success: true });
});

// Rename session
router.put('/:id/name', (req, res) => {
  const db = getDb();
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const result = db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Session not found' });
  }
  // Broadcast name change to any active session listeners
  const session = getSession(req.params.id);
  if (session) {
    session.broadcast({
      type: 'session_name_updated',
      sessionId: req.params.id,
      name: name.trim(),
      timestamp: new Date().toISOString()
    });
  }
  res.json({ success: true, name: name.trim() });
});

// Archive / unarchive session
router.post('/:id/archive', (req, res) => {
  const db = getDb();
  const { archived } = req.body;
  const value = archived ? 1 : 0;
  const result = db.prepare('UPDATE sessions SET archived = ? WHERE id = ?').run(value, req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({ success: true, archived: value });
});

// End session
router.post('/:id/end', (req, res) => {
  try {
    endSession(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get session messages
router.get('/:id/messages', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;

  const messages = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ?
    ORDER BY timestamp ASC
    LIMIT ? OFFSET ?
  `).all(req.params.id, limit, offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(req.params.id);

  res.json({
    messages,
    total: total.count,
    limit,
    offset
  });
});

// Get session summary
router.get('/:id/summary', (req, res) => {
  const db = getDb();
  const summary = db.prepare(`
    SELECT * FROM session_summaries
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(req.params.id);

  res.json(summary || null);
});

// Toggle plan mode
// Note: Permission mode is set at session creation and cannot be changed mid-session
// Update permission mode
// Note: Permission mode is set at session creation. This updates the stored preference.
router.post('/:id/permission-mode', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or not active' });
  }

  const { permissionMode } = req.body;
  const valid = ['acceptEdits', 'auto', 'plan', 'default'];
  if (!valid.includes(permissionMode)) {
    return res.status(400).json({ error: `Invalid permission mode. Must be one of: ${valid.join(', ')}` });
  }

  session.permissionMode = permissionMode;
  const db = getDb();
  db.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run(permissionMode, req.params.id);

  res.json({
    success: true,
    permissionMode: session.permissionMode,
    note: 'Permission mode changes take effect on next session. The running process retains its original mode.'
  });
});

// Get session preview URL
router.get('/:id/preview-url', (req, res) => {
  const db = getDb();
  const session = db.prepare('SELECT preview_url FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({ preview_url: session.preview_url });
});

// Update session preview URL
router.put('/:id/preview-url', (req, res) => {
  const db = getDb();
  const { url } = req.body;
  const result = db.prepare('UPDATE sessions SET preview_url = ? WHERE id = ?').run(url, req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({ preview_url: url });
});

// Update working directory for a session (called by CwdChanged hook)
router.post('/cwd-update', (req, res) => {
  const db = getDb();
  const { session_id, working_directory } = req.body;

  if (!session_id || !working_directory) {
    return res.status(400).json({ error: 'session_id and working_directory required' });
  }

  const result = db.prepare('UPDATE sessions SET working_directory = ?, last_activity_at = datetime(\'now\') WHERE id = ?')
    .run(working_directory, session_id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({ success: true, working_directory });
});

module.exports = router;
