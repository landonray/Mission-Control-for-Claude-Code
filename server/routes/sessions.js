const express = require('express');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const router = express.Router();
const { query } = require('../database');
const { createSession, getSession, getAllActiveSessions, endSession, resumeSession } = require('../services/sessionManager');
const { getGitPipeline } = require('../services/fileWatcher');

// Some runtimes (e.g. tsx) wrap ESM named exports under .default when imported from CJS
function unwrapDefault(mod) {
  return mod && mod.default && typeof mod.default === 'object' ? mod.default : mod;
}

let _worktreeCleanup;
async function loadWorktreeCleanup() {
  if (!_worktreeCleanup) {
    _worktreeCleanup = unwrapDefault(await import('../services/worktreeCleanup.js'));
  }
  return _worktreeCleanup;
}

// List all sessions (active + recent + ended — unified view)
router.get('/', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const status = req.query.status;

  let sql = 'SELECT * FROM sessions ORDER BY created_at DESC LIMIT $1';
  let params = [limit];

  if (status) {
    sql = 'SELECT * FROM sessions WHERE status = $1 ORDER BY created_at DESC LIMIT $2';
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
        "UPDATE sessions SET status = 'ended', ended_at = COALESCE(ended_at, NOW()) WHERE id = $1",
        [s.id]
      );
      s.status = 'ended';
    }
    const activeInfo = active.find(a => a.id === s.id);
    // If session is active in memory, trust the in-memory status over DB
    // This prevents oscillation when DB and memory disagree after recovery
    if (activeInfo && s.status !== activeInfo.status) {
      s.status = activeInfo.status;
      query("UPDATE sessions SET status = $1 WHERE id = $2", [activeInfo.status, s.id]).catch(() => {});
    }
    let projectName = 'Ungrouped';
    if (s.working_directory) {
      // Worktree paths like /foo/Project/.claude/worktrees/xyz → use "Project"
      const wtMatch = s.working_directory.match(/^(.+)\/\.claude\/worktrees\//);
      projectName = wtMatch ? path.basename(wtMatch[1]) : path.basename(s.working_directory);
    }
    // Only compute pipeline when worktree is ready (or session doesn't use worktrees).
    // Before init fires, working_directory still points at the main repo, which would
    // produce misleading status (e.g. "merged: done" when the branch doesn't exist yet).
    const worktreeReady = activeInfo ? activeInfo.worktreeReady : true; // ended sessions are already resolved
    const needsPipeline = !s.archived && s.working_directory && worktreeReady;

    enriched.push({
      ...s,
      project_name: projectName,
      isActive: !!activeInfo,
      pendingPermission: !!(activeInfo?.pendingPermission),
      archived: !!s.archived,
      resumable: s.status === 'ended', // All ended sessions are resumable
      pipeline: null, // filled below
      _needsPipeline: needsPipeline
    });
  }

  // Compute git pipelines in parallel (async)
  await Promise.all(enriched.map(async (s) => {
    if (s._needsPipeline) {
      s.pipeline = await getGitPipeline(s.working_directory);
    }
    delete s._needsPipeline;
  }));

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
      "UPDATE sessions SET status = 'ended', ended_at = COALESCE(ended_at, NOW()) WHERE id = $1",
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
router.post('/', async (req, res) => {
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

    const session = await createSession(options);
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
      session = await resumeSession(req.params.id, req.body.content);
      if (!session) {
        return res.status(500).json({ error: 'Failed to resume session' });
      }
      return res.json({ success: true, resumed: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    await session.sendMessage(req.body.content);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a queued message that hasn't been processed yet
router.post('/:id/delete-queued-message', (req, res) => {
  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }

  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const deleted = session.deleteQueuedMessage(content);
  if (deleted) {
    res.json({ success: true, message: 'Queued message deleted' });
  } else {
    res.status(404).json({ error: 'Message not found in queue or already sent' });
  }
});

// Interrupt a working session (send Escape via tmux)
router.post('/:id/interrupt', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const interrupted = session.interrupt();
  if (interrupted) {
    res.json({ success: true });
  } else {
    res.status(409).json({ error: 'Session is not in a state that can be interrupted' });
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

// Check worktree status for uncommitted changes and open PRs
router.get('/:id/worktree-status', async (req, res) => {
  try {
    const result = await query('SELECT working_directory, use_worktree FROM sessions WHERE id = $1', [req.params.id]);
    const session = result.rows[0];
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!session.use_worktree || !session.working_directory) {
      return res.json({ hasUncommittedChanges: false, openPR: null, worktreePath: null });
    }
    const { getWorktreeStatus, checkBranchPR } = await loadWorktreeCleanup();
    const status = getWorktreeStatus(session.working_directory);

    // Check for open PRs on this branch
    const worktreePath = session.working_directory;
    const wtMatch = worktreePath.match(/^(.+?)\/\.claude\/worktrees\/(.+)$/);
    const projectRoot = wtMatch ? wtMatch[1] : null;
    let openPR = null;
    if (projectRoot) {
      let branchName = null;
      try {
        branchName = execFileSync('git', ['branch', '--show-current'], {
          cwd: worktreePath,
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
      } catch (e) {
        // Worktree may be gone
      }
      if (branchName) {
        openPR = checkBranchPR(branchName, projectRoot);
      }
    }

    res.json({ ...status, openPR });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// End session (with optional worktree commit/cleanup)
router.post('/:id/end', async (req, res) => {
  try {
    const { commit, cleanup, keepBranch } = req.body || {};
    const sessionId = req.params.id;

    if (commit || cleanup) {
      const result = await query('SELECT working_directory, use_worktree, worktree_name FROM sessions WHERE id = $1', [sessionId]);
      const session = result.rows[0];

      if (session && session.use_worktree && session.working_directory) {
        const worktreePath = session.working_directory;
        const wtMatch = worktreePath.match(/^(.+?)\/\.claude\/worktrees\/(.+)$/);
        const projectRoot = wtMatch ? wtMatch[1] : null;

        // Only proceed if this is actually a worktree path
        if (projectRoot) {
          const { commitWorktreeChanges, cleanupWorktree } = await loadWorktreeCleanup();

          // Get branch name from git, fall back to worktree_name from DB
          let branchName = null;
          try {
            branchName = execFileSync('git', ['branch', '--show-current'], {
              cwd: worktreePath,
              encoding: 'utf-8',
              timeout: 5000,
            }).trim();
          } catch (e) {
            // Worktree may already be gone — fall back to DB
          }
          if (!branchName && session.worktree_name) {
            branchName = `worktree-${session.worktree_name}`;
          }

          if (commit) {
            commitWorktreeChanges(worktreePath);
          }

          if (cleanup) {
            const deleteBranch = !commit && !keepBranch;
            cleanupWorktree(worktreePath, branchName, projectRoot, deleteBranch);
          }
        }
      }
    }

    await endSession(sessionId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get session messages
router.get('/:id/messages', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10000;
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
  } catch (err) {
    console.error(`[API] Failed to load messages for session ${req.params.id}:`, err.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// Get session stream events (CLI history)
router.get('/:id/stream-events', async (req, res) => {
  try {
    const events = (await query(`
      SELECT event_type, event_data, timestamp FROM stream_events
      WHERE session_id = $1
      ORDER BY timestamp ASC
    `, [req.params.id])).rows;

    res.json({
      events: events.map(e => JSON.parse(e.event_data))
    });
  } catch (err) {
    console.error(`[API] Failed to load stream events for session ${req.params.id}:`, err.message);
    res.status(500).json({ error: 'Failed to load stream events' });
  }
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
  const valid = ['acceptEdits', 'auto', 'plan', 'default', 'bypassPermissions', 'dontAsk'];
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
  const sessionResult = await query('SELECT use_worktree FROM sessions WHERE id = $1', [session_id]);
  const session = sessionResult.rows[0];
  if (session && session.use_worktree) {
    try {
      const resolvedDir = working_directory.replace(/^~/, process.env.HOME || '');
      const worktreeOutput = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: resolvedDir,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      // First line is "worktree /path/to/worktree"
      const worktreeFirstLine = worktreeOutput.split('\n')[0] || '';
      const worktreeDir = worktreeFirstLine.replace(/^worktree\s+/, '');
      const name = path.basename(worktreeDir);
      if (name) {
        await query('UPDATE sessions SET worktree_name = $1 WHERE id = $2', [name, session_id]);
      }
    } catch (e) {
      // Fall back to extracting name from directory path
      const name = path.basename(working_directory);
      await query('UPDATE sessions SET worktree_name = $1 WHERE id = $2', [name, session_id]);
    }
  }

  res.json({ success: true, working_directory });
});

module.exports = router;
