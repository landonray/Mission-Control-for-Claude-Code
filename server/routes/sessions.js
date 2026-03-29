const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { createSession, getSession, getAllActiveSessions, endSession } = require('../services/sessionManager');

// List all sessions (active + recent)
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

  const enriched = sessions.map(s => {
    const activeInfo = active.find(a => a.id === s.id);
    return {
      ...s,
      isActive: !!activeInfo,
      pendingPermission: activeInfo?.pendingPermission || null
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
  session.isActive = !!activeSession;
  session.pendingPermission = activeSession?.pendingPermission || null;

  res.json(session);
});

// Create new session
router.post('/', (req, res) => {
  try {
    const { name, workingDirectory, presetId, permissionMode, autoAccept, planMode, initialPrompt, branch, mcpConnections } = req.body;

    let options = {
      name,
      workingDirectory,
      permissionMode,
      autoAccept,
      planMode,
      initialPrompt,
      branch,
      mcpConnections
    };

    // If preset is specified, load preset settings
    if (presetId) {
      const db = getDb();
      const preset = db.prepare('SELECT * FROM presets WHERE id = ?').get(presetId);
      if (preset) {
        options = {
          ...options,
          name: name || preset.name,
          workingDirectory: workingDirectory || preset.working_directory,
          permissionMode: permissionMode || preset.permission_mode,
          initialPrompt: initialPrompt || preset.initial_prompt,
          mcpConnections: preset.mcp_connections ? JSON.parse(preset.mcp_connections) : [],
          presetId
        };
      }
    }

    const session = createSession(options);
    res.status(201).json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send message to session
router.post('/:id/message', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or not active' });
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
// in Claude Code. This updates the stored preference for the next session.
router.post('/:id/plan-mode', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or not active' });
  }

  session.planMode = req.body.enabled;
  const db = getDb();
  db.prepare('UPDATE sessions SET plan_mode = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, req.params.id);

  res.json({
    success: true,
    planMode: session.planMode,
    note: 'Permission mode changes take effect on next session. The running process retains its original mode.'
  });
});

// Toggle auto-accept
// Note: Permission mode is set at session creation. This updates preference only.
router.post('/:id/auto-accept', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or not active' });
  }

  session.autoAccept = req.body.enabled;
  const db = getDb();
  db.prepare('UPDATE sessions SET auto_accept = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, req.params.id);

  res.json({ success: true, autoAccept: session.autoAccept });
});

module.exports = router;
