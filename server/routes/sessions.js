const express = require('express');
const path = require('path');
const { execSync } = require('child_process');
const router = express.Router();
const { query } = require('../database');
const { createSession, getSession, getAllActiveSessions, endSession, resumeSession } = require('../services/sessionManager');

// List all sessions (active + recent + ended — unified view)
router.get('/', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const status = req.query.status;

  let sql = 'SELECT * FROM sessions ORDER BY last_activity_at DESC LIMIT $1';
  let params = [limit];

  if (status) {
    sql = 'SELECT * FROM sessions WHERE status = $1 ORDER BY last_activity_at DESC LIMIT $2';
    params = [status, limit];
  }

  const sessions = (await query(sql, params)).rows;
  const active = getAllActiveSessions();

  // Reconcile stale statuses: if a session shows non-ended in DB
  // but is no longer tracked in memory, mark it as ended.
  // Skip sessions that have a tmux_session_name — they may still be running in tmux.
  const activeIds = new Set(active.map(a => a.id));

  const enriched = [];
  for (const s of sessions) {
    const isStale = s.status !== 'ended' && !activeIds.has(s.id) && !s.tmux_session_name;
    if (isStale) {
      await query(
        "UPDATE sessions SET status = 'ended', ended_at = COALESCE(ended_at, NOW()::text) WHERE id = $1",
        [s.id]
      );
      s.status = 'ended';
    }
    const activeInfo = active.find(a => a.id === s.id);
    const projectName = s.working_directory
      ? path.basename(s.working_directory)
      : 'Ungrouped';
    enriched.push({
      ...s,
      project_name: projectName,
      isActive: !!activeInfo,
      pendingPermission: activeInfo?.pendingPermission || null,
      archived: !!s.archived,
      resumable: s.status === 'ended' // All ended sessions are resumable
    });
  }

  res.json(enriched);
});

// Get single session details
router.get('/:id', async (req, res) => {
  const session = (await query('SELECT * FROM sessions WHERE id = $1', [req.params.id])).rows[0];

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const activeSession = getSession(req.params.id);

  // Reconcile stale status — skip tmux sessions
  if (session.status !== 'ended' && !activeSession && !session.tmux_session_name) {
    await query(
      "UPDATE sessions SET status = 'ended', ended_at = COALESCE(ended_at, NOW()::text) WHERE id = $1",
      [req.params.id]
    );
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
router.post('/:id/message', async (req, res) => {
  let session = getSession(req.params.id);

  if (!session) {
    // Session not in memory — check if it exists in DB for resume
    const dbSession = (await query('SELECT id FROM sessions WHERE id = $1', [req.params.id])).rows[0];
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
router.put('/:id/name', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const result = await query('UPDATE sessions SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
  if (result.rowCount === 0) {
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
router.post('/:id/archive', async (req, res) => {
  const { archived } = req.body;
  const value = archived ? 1 : 0;
  const result = await query('UPDATE sessions SET archived = $1 WHERE id = $2', [value, req.params.id]);
  if (result.rowCount === 0) {
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
router.get('/:id/messages', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;

  const messages = (await query(`
    SELECT * FROM messages
    WHERE session_id = $1
    ORDER BY timestamp ASC
    LIMIT $2 OFFSET $3
  `, [req.params.id, limit, offset])).rows;

  const total = (await query('SELECT COUNT(*) as count FROM messages WHERE session_id = $1', [req.params.id])).rows[0];

  res.json({
    messages,
    total: total.count,
    limit,
    offset
  });
});

// Get session summary
router.get('/:id/summary', async (req, res) => {
  const summary = (await query(`
    SELECT * FROM session_summaries
    WHERE session_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [req.params.id])).rows[0];

  res.json(summary || null);
});

// Toggle plan mode
// Note: Permission mode is set at session creation and cannot be changed mid-session
// Update permission mode
// Note: Permission mode is set at session creation. This updates the stored preference.
router.post('/:id/permission-mode', async (req, res) => {
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
  await query('UPDATE sessions SET permission_mode = $1 WHERE id = $2', [permissionMode, req.params.id]);

  res.json({
    success: true,
    permissionMode: session.permissionMode,
    note: 'Permission mode changes take effect on next session. The running process retains its original mode.'
  });
});

// Get session preview URL
router.get('/:id/preview-url', async (req, res) => {
  const session = (await query('SELECT preview_url FROM sessions WHERE id = $1', [req.params.id])).rows[0];
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({ preview_url: session.preview_url });
});

// Update session preview URL
router.put('/:id/preview-url', async (req, res) => {
  const { url } = req.body;
  const result = await query('UPDATE sessions SET preview_url = $1 WHERE id = $2', [url, req.params.id]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({ preview_url: url });
});

// Update working directory for a session (called by CwdChanged hook)
router.post('/cwd-update', async (req, res) => {
  const { session_id, working_directory } = req.body;

  if (!session_id || !working_directory) {
    return res.status(400).json({ error: 'session_id and working_directory required' });
  }

  const result = await query(
    'UPDATE sessions SET working_directory = $1, last_activity_at = NOW() WHERE id = $2',
    [working_directory, session_id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Detect worktree name for worktree sessions
  const session = db.prepare('SELECT use_worktree FROM sessions WHERE id = ?').get(session_id);
  if (session && session.use_worktree) {
    try {
      const resolvedDir = working_directory.replace(/^~/, process.env.HOME || '');
      const worktreeName = execSync('git worktree list --porcelain 2>/dev/null | head -1', {
        cwd: resolvedDir,
        encoding: 'utf-8',
        timeout: 5000
      }).trim();
      // Extract directory name from "worktree /path/to/worktree"
      const worktreeDir = worktreeName.replace(/^worktree\s+/, '');
      const name = path.basename(worktreeDir);
      if (name) {
        db.prepare('UPDATE sessions SET worktree_name = ? WHERE id = ?').run(name, session_id);
      }
    } catch (e) {
      // Fall back to extracting name from directory path
      const name = path.basename(working_directory);
      db.prepare('UPDATE sessions SET worktree_name = ? WHERE id = ?').run(name, session_id);
    }
  }

  res.json({ success: true, working_directory });
});

module.exports = router;
