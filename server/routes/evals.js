const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');

// ESM service loaders (lazy dynamic import for CJS compatibility)
let _projectDiscovery;
async function getProjectDiscovery() {
  if (!_projectDiscovery) _projectDiscovery = await import('../services/projectDiscovery.js');
  return _projectDiscovery;
}

let _evalLoader;
async function getEvalLoader() {
  if (!_evalLoader) _evalLoader = await import('../services/evalLoader.js');
  return _evalLoader;
}

let _evalRunner;
async function getEvalRunner() {
  if (!_evalRunner) _evalRunner = await import('../services/evalRunner.js');
  return _evalRunner;
}

let _evalReporter;
async function getEvalReporter() {
  if (!_evalReporter) _evalReporter = await import('../services/evalReporter.js');
  return _evalReporter;
}

// Track running batches per project to prevent duplicates
const runningBatches = new Map();

// GET /folders/:projectId — discover eval folders from disk, merge with armed state
router.get('/folders/:projectId', async (req, res) => {
  try {
    const { getProject } = await getProjectDiscovery();
    const { discoverEvalFolders, loadEvalFolder } = await getEvalLoader();

    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const folderPaths = discoverEvalFolders(project.root_path, project.config);

    // Get armed state from DB
    const armed = await query(
      'SELECT * FROM eval_armed_folders WHERE project_id = $1',
      [project.id]
    );
    const armedMap = new Map(armed.rows.map(r => [r.folder_path, r]));

    const folders = folderPaths.map(fp => {
      const name = require('path').basename(fp);
      const armedRow = armedMap.get(fp);

      // Load eval details from disk for folder expansion
      let evals = [];
      try {
        const loaded = loadEvalFolder(fp);
        evals = loaded.map(ev => ({
          name: ev.name,
          description: ev.description || null,
          evidence_type: ev.evidence?.type || null,
        }));
      } catch (err) {
        console.warn(`[Evals] Failed to load evals from ${fp}:`, err.message);
      }

      return {
        folder_path: fp,
        folder_name: name,
        armed: !!armedRow,
        triggers: armedRow ? armedRow.triggers : 'manual',
        auto_send: armedRow ? armedRow.auto_send : 0,
        id: armedRow ? armedRow.id : null,
        eval_count: evals.length,
        evals,
      };
    });

    res.json(folders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /folders/:projectId/arm — arm a folder
router.post('/folders/:projectId/arm', async (req, res) => {
  try {
    const { folder_path, folder_name } = req.body;
    if (!folder_path || !folder_name) {
      return res.status(400).json({ error: 'folder_path and folder_name are required' });
    }

    const id = uuidv4();
    const result = await query(
      `INSERT INTO eval_armed_folders (id, project_id, folder_path, folder_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, folder_path) DO UPDATE SET folder_name = EXCLUDED.folder_name
       RETURNING *`,
      [id, req.params.projectId, folder_path, folder_name]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /folders/:projectId/disarm — disarm a folder
router.post('/folders/:projectId/disarm', async (req, res) => {
  try {
    const { folder_path } = req.body;
    if (!folder_path) {
      return res.status(400).json({ error: 'folder_path is required' });
    }

    await query(
      'DELETE FROM eval_armed_folders WHERE project_id = $1 AND folder_path = $2',
      [req.params.projectId, folder_path]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /folders/:projectId/settings — update triggers and auto_send
router.put('/folders/:projectId/settings', async (req, res) => {
  try {
    const { folder_path, triggers, auto_send } = req.body;
    if (!folder_path) {
      return res.status(400).json({ error: 'folder_path is required' });
    }

    const result = await query(
      `UPDATE eval_armed_folders SET triggers = COALESCE($1, triggers), auto_send = COALESCE($2, auto_send)
       WHERE project_id = $3 AND folder_path = $4 RETURNING *`,
      [triggers, auto_send, req.params.projectId, folder_path]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Armed folder not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /run/:projectId — manually run all armed evals
router.post('/run/:projectId', async (req, res) => {
  try {
    const projectId = req.params.projectId;

    if (runningBatches.has(projectId)) {
      return res.status(409).json({ error: 'A batch is already running for this project' });
    }

    const result = await executeBatch(projectId, 'manual', null, null);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /history/:projectId — list recent eval batches
router.get('/history/:projectId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const result = await query(
      'SELECT * FROM eval_batches WHERE project_id = $1 ORDER BY started_at DESC LIMIT $2',
      [req.params.projectId, limit]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /batch/:batchId — list runs for a batch
router.get('/batch/:batchId', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM eval_runs WHERE batch_id = $1 ORDER BY timestamp ASC',
      [req.params.batchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /eval-history/:projectId/:evalName — last N runs for a specific eval
router.get('/eval-history/:projectId/:evalName', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const result = await query(
      `SELECT er.* FROM eval_runs er
       JOIN eval_batches eb ON er.batch_id = eb.id
       WHERE eb.project_id = $1 AND er.eval_name = $2
       ORDER BY er.timestamp DESC LIMIT $3`,
      [req.params.projectId, req.params.evalName, limit]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Execute a full eval batch for a project.
 * Shared by the manual /run endpoint and the session_end trigger.
 */
async function executeBatch(projectId, triggerSource, sessionId, tmuxSessionName) {
  // Set the running flag immediately (synchronously) to prevent TOCTOU race.
  // Two concurrent calls could both pass the has-check before either sets the flag
  // if we waited until after the awaits below.
  if (runningBatches.has(projectId)) {
    return { message: 'A batch is already running', total: 0 };
  }
  runningBatches.set(projectId, true);

  try {
    const { getProject } = await getProjectDiscovery();
    const { loadEvalFolder } = await getEvalLoader();
    const { runSingleEval } = await getEvalRunner();

    const project = await getProject(projectId);
    if (!project) throw new Error('Project not found');

    // Get armed folders
    const armedResult = await query(
      'SELECT * FROM eval_armed_folders WHERE project_id = $1',
      [projectId]
    );
    const armedFolders = armedResult.rows;

    if (armedFolders.length === 0) {
      return { message: 'No armed eval folders', total: 0 };
    }

    // If trigger-based, filter to folders matching the trigger
    const matchingFolders = triggerSource === 'manual'
      ? armedFolders
      : armedFolders.filter(f => f.triggers.split(',').map(t => t.trim()).includes(triggerSource));

    if (matchingFolders.length === 0) {
      return { message: 'No armed folders match this trigger', total: 0 };
    }

    // Get current commit SHA
    let commitSha = null;
    try {
      const { execSync } = require('child_process');
      commitSha = execSync('git rev-parse --short HEAD', {
        cwd: project.root_path,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (e) {}

    // Create batch
    const batchId = uuidv4();
    await query(
      `INSERT INTO eval_batches (id, project_id, trigger_source, commit_sha, session_id, status)
       VALUES ($1, $2, $3, $4, $5, 'running')`,
      [batchId, projectId, triggerSource, commitSha, sessionId]
    );

    try {
      // Load evals from all matching folders
      const allEvals = [];
      for (const folder of matchingFolders) {
        const evals = loadEvalFolder(folder.folder_path);
        for (const evalDef of evals) {
          allEvals.push({ evalDef, folder });
        }
      }

      // Build shared context for evidence gatherers
      const pg = await import('pg');
      const baseContext = {
        projectRoot: project.root_path,
        commitSha,
        triggerSource,
        // DB readonly connection — required for db_query evidence
        dbReadonlyUrl: process.env.DATABASE_URL_READONLY || null,
        createDbConnection: (url) => {
          const client = new pg.default.Client({ connectionString: url });
          client.connect();
          return client;
        },
        // Session log path — capture tmux scrollback if session is available
        sessionLogPath: null,
        buildOutputPath: null,
      };

      // If triggered from a session, try to capture the session log
      if (sessionId && tmuxSessionName) {
        try {
          const { execSync } = require('child_process');
          const os = require('os');
          const fs = require('fs');
          const logPath = require('path').join(os.tmpdir(), `eval-session-log-${sessionId}.txt`);
          const sanitizedSession = tmuxSessionName.replace(/[^a-zA-Z0-9_\-.:]/g, '');
          if (sanitizedSession === tmuxSessionName) {
            execSync(`tmux capture-pane -t '${sanitizedSession}' -p -S -5000 > '${logPath}'`, { stdio: 'pipe' });
            if (fs.existsSync(logPath)) {
              baseContext.sessionLogPath = logPath;
            }
          }
        } catch (e) {
          // Session may already be gone — that's fine, log_query evals will error gracefully
        }
      }

      // Run all evals
      const results = [];
      for (const { evalDef, folder } of allEvals) {
        // Per-eval context: inject the eval's input map as variables for interpolation
        const context = {
          ...baseContext,
          variables: {
            input: evalDef.input || {},
            eval: { name: evalDef.name },
            run: { commit_sha: commitSha, trigger: triggerSource },
            project: { root: project.root_path },
          },
          // Also expose top-level shortcuts for interpolateVariables
          input: evalDef.input || {},
          eval: { name: evalDef.name },
          run: { commit_sha: commitSha, trigger: triggerSource },
          project: { root: project.root_path },
        };
        const result = await runSingleEval(evalDef, context);
        result.evalFolder = folder.folder_path;
        results.push(result);

        // Store run in DB
        const runId = uuidv4();
        await query(
          `INSERT INTO eval_runs (id, batch_id, eval_name, eval_folder, commit_sha, trigger_source, input, evidence, check_results, judge_verdict, state, fail_reason, error_message, duration)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            runId, batchId, result.evalName, folder.folder_path, commitSha, triggerSource,
            evalDef.expected ? JSON.stringify(evalDef.expected) : null,
            result.evidence ? JSON.stringify(result.evidence) : null,
            result.checkResults ? JSON.stringify(result.checkResults) : null,
            result.judgeVerdict ? JSON.stringify(result.judgeVerdict) : null,
            result.state,
            result.failReason || null,
            result.error || null,
            result.duration || 0,
          ]
        );
      }

      // Tally results
      const passed = results.filter(r => r.state === 'pass').length;
      const failed = results.filter(r => r.state === 'fail').length;
      const errors = results.filter(r => r.state === 'error').length;

      // Update batch
      await query(
        `UPDATE eval_batches SET total = $1, passed = $2, failed = $3, errors = $4, completed_at = NOW(), status = 'complete'
         WHERE id = $5`,
        [results.length, passed, failed, errors, batchId]
      );

      const summary = { batchId, total: results.length, passed, failed, errors, status: 'complete' };

      return { ...summary, results };
    } catch (err) {
      await query(
        `UPDATE eval_batches SET status = 'error', completed_at = NOW() WHERE id = $1`,
        [batchId]
      );
      throw err;
    }
  } finally {
    runningBatches.delete(projectId);
  }
}

/**
 * Trigger an eval run — called from session manager on session_end.
 * Fire-and-forget: logs errors but does not throw.
 */
async function triggerEvalRun(projectId, triggerSource, sessionId, tmuxSessionName) {
  try {
    if (runningBatches.has(projectId)) {
      console.log(`[Evals] Skipping trigger — batch already running for project ${projectId}`);
      return;
    }

    const result = await executeBatch(projectId, triggerSource, sessionId, tmuxSessionName);

    if (!result || !result.results || result.results.length === 0) return;

    const hasFailures = result.failed > 0 || result.errors > 0;
    if (!hasFailures || !tmuxSessionName) return;

    // Check if any armed folder has auto_send enabled
    const armedResult = await query(
      'SELECT * FROM eval_armed_folders WHERE project_id = $1 AND auto_send = 1',
      [projectId]
    );
    if (armedResult.rows.length === 0) return;

    // Get history for failure message
    const historyResults = [];
    const evalNames = [...new Set(result.results.map(r => r.evalName))];
    for (const name of evalNames) {
      const hist = await query(
        `SELECT er.eval_name, er.state, er.commit_sha FROM eval_runs er
         JOIN eval_batches eb ON er.batch_id = eb.id
         WHERE eb.project_id = $1 AND er.eval_name = $2
         ORDER BY er.timestamp DESC LIMIT 3`,
        [projectId, name]
      );
      historyResults.push(...hist.rows);
    }

    // Compose and send failure message
    const { composeFailureMessage } = await getEvalReporter();
    const message = composeFailureMessage(result.results, historyResults, {
      total: result.total,
      passed: result.passed,
      failed: result.failed,
      errors: result.errors,
    });

    // Send via tmux — sanitize session name to prevent command injection
    const { execSync } = require('child_process');
    const sanitizedSession = tmuxSessionName.replace(/[^a-zA-Z0-9_\-.:]/g, '');
    if (!sanitizedSession || sanitizedSession !== tmuxSessionName) {
      console.warn(`[Evals] Refusing to send to suspicious tmux session name: ${tmuxSessionName}`);
      return;
    }
    const escaped = message.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t '${sanitizedSession}' '${escaped}' Enter`, { stdio: 'ignore' });
    console.log(`[Evals] Sent failure message to tmux session ${sanitizedSession}`);
  } catch (err) {
    console.error(`[Evals] triggerEvalRun error:`, err.message);
  }
}

module.exports = router;
module.exports.triggerEvalRun = triggerEvalRun;
module.exports.executeBatch = executeBatch;
