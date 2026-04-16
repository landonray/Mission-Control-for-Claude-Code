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

let _prWatcher;
async function getPrWatcher() {
  if (!_prWatcher) _prWatcher = await import('../services/prWatcher.js');
  return _prWatcher;
}

let _evalAuthoring;
async function getEvalAuthoring() {
  if (!_evalAuthoring) _evalAuthoring = await import('../services/evalAuthoring.js');
  return _evalAuthoring;
}

// Track running batches per project to prevent duplicates
const runningBatches = new Map();

// GET /folders/:projectId — discover eval folders from disk, merge with armed state
router.get('/folders/:projectId', async (req, res) => {
  try {
    const { getProject } = await getProjectDiscovery();
    const { discoverEvalFolders, loadEvalFolder, loadDraftsFromFolder } = await getEvalLoader();

    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const folderPaths = discoverEvalFolders(project.root_path, project.config);

    // Get armed state from DB
    const armed = await query(
      'SELECT * FROM eval_armed_folders WHERE project_id = $1',
      [project.id]
    );
    const armedMap = new Map(armed.rows.map(r => [r.folder_path, r]));

    // Query last run state per eval per folder for status dots
    const lastRunResult = await query(`
      SELECT DISTINCT ON (er.eval_name, er.eval_folder)
        er.eval_name, er.eval_folder, er.state,
        CASE WHEN er.judge_verdict::text LIKE '%"confidence":"low"%' THEN true ELSE false END AS low_confidence
      FROM eval_runs er
      JOIN eval_batches eb ON er.batch_id = eb.id
      WHERE eb.project_id = $1
      ORDER BY er.eval_name, er.eval_folder, er.timestamp DESC
    `, [project.id]);
    // Build a map: folder_path -> [{eval_name, state, low_confidence}]
    const lastRunMap = new Map();
    for (const row of lastRunResult.rows) {
      if (!lastRunMap.has(row.eval_folder)) lastRunMap.set(row.eval_folder, []);
      lastRunMap.get(row.eval_folder).push({
        eval_name: row.eval_name,
        state: row.state,
        low_confidence: row.low_confidence,
      });
    }

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

      // Load draft evals from disk
      let drafts = [];
      try {
        const loadedDrafts = loadDraftsFromFolder(fp);
        drafts = loadedDrafts.map(ev => ({
          name: ev.name,
          description: ev.description || null,
          evidence_type: ev.evidence?.type || null,
          isDraft: true,
          draftPath: ev._source,
        }));
      } catch (err) {
        console.warn(`[Evals] Failed to load drafts from ${fp}:`, err.message);
      }

      // Attach last-run status dots: one per eval in this folder
      const lastRuns = lastRunMap.get(fp) || [];

      return {
        folder_path: fp,
        folder_name: name,
        armed: !!armedRow,
        triggers: armedRow ? armedRow.triggers : 'manual',
        auto_send: armedRow ? armedRow.auto_send : 0,
        id: armedRow ? armedRow.id : null,
        eval_count: evals.length,
        evals,
        drafts,
        last_run_status: lastRuns,
      };
    });

    res.json(folders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /folders/:projectId/create — create a new eval folder on disk
router.post('/folders/:projectId/create', async (req, res) => {
  try {
    const { folder_name } = req.body;
    if (!folder_name || typeof folder_name !== 'string' || !folder_name.trim()) {
      return res.status(400).json({ error: 'folder_name is required' });
    }
    const sanitized = folder_name.trim();
    if (/[\/\\\.]+/.test(sanitized) || sanitized.includes('..')) {
      return res.status(400).json({ error: 'Invalid folder name — no path separators or traversal allowed' });
    }
    const { getProject } = await getProjectDiscovery();
    const { getEvalsBaseDir } = await getEvalLoader();
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const baseDir = getEvalsBaseDir(project.root_path, project.config);
    const path = require('path');
    const folderPath = path.join(baseDir, sanitized);
    const projectRoot = project.root_path.endsWith('/') ? project.root_path : project.root_path + '/';
    if (!folderPath.startsWith(projectRoot) && folderPath !== project.root_path) {
      return res.status(400).json({ error: 'Folder path must be inside the project' });
    }
    const fs = require('fs');
    if (fs.existsSync(folderPath)) {
      return res.status(409).json({ error: 'Folder already exists' });
    }
    fs.mkdirSync(folderPath, { recursive: true });
    res.status(201).json({ folder_path: folderPath, folder_name: sanitized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /folders/:projectId/create-eval — create a new eval YAML file on disk
router.post('/folders/:projectId/create-eval', async (req, res) => {
  try {
    const { folder_path, name, description, evidence, input, checks, judge_prompt, expected, judge, saveAsDraft } = req.body;

    // Required field validation
    if (!folder_path || typeof folder_path !== 'string' || !folder_path.trim()) {
      return res.status(400).json({ error: 'folder_path is required' });
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!description || typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ error: 'description is required' });
    }
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      return res.status(400).json({ error: 'evidence is required and must be an object' });
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return res.status(400).json({ error: 'input is required and must be a key-value map' });
    }
    if (!checks && !judge_prompt) {
      return res.status(400).json({ error: 'At least one of "checks" or "judge_prompt" is required' });
    }
    if (judge_prompt && !expected) {
      return res.status(400).json({ error: '"expected" is required when "judge_prompt" is provided' });
    }

    const { getProject } = await getProjectDiscovery();
    const { VALID_EVIDENCE_TYPES, VALID_CHECK_TYPES, loadEval } = await getEvalLoader();

    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Path safety check — folder_path must be inside project root
    const projectRoot = project.root_path.endsWith('/') ? project.root_path : project.root_path + '/';
    if (!folder_path.startsWith(projectRoot) && folder_path !== project.root_path) {
      return res.status(400).json({ error: 'folder_path must be inside the project' });
    }

    // Verify folder exists
    const fs = require('fs');
    if (!fs.existsSync(folder_path)) {
      return res.status(400).json({ error: 'Folder does not exist' });
    }

    // Validate evidence type
    if (!evidence.type || !VALID_EVIDENCE_TYPES.includes(evidence.type)) {
      return res.status(400).json({
        error: `Invalid evidence type "${evidence.type}" — must be one of ${VALID_EVIDENCE_TYPES.join(', ')}`,
      });
    }

    // Validate check types
    if (checks && Array.isArray(checks)) {
      for (const check of checks) {
        if (check.type && !VALID_CHECK_TYPES.includes(check.type)) {
          return res.status(400).json({
            error: `Invalid check type "${check.type}" — must be one of ${VALID_CHECK_TYPES.join(', ')}`,
          });
        }
      }
    }

    // Sanitize eval name for filename
    const path = require('path');
    const sanitizedName = name.trim().replace(/[^a-zA-Z0-9]+/g, '_');
    const extension = saveAsDraft ? '.yaml.draft' : '.yaml';
    const filePath = path.join(folder_path, sanitizedName + extension);

    // Check for existing file
    if (fs.existsSync(filePath)) {
      return res.status(409).json({ error: 'An eval file with that name already exists' });
    }

    // Build YAML object
    const evalDef = { name: name.trim(), description: description.trim(), evidence, input };
    if (checks) evalDef.checks = checks;
    if (judge_prompt) evalDef.judge_prompt = judge_prompt;
    if (expected) evalDef.expected = expected;
    if (judge) evalDef.judge = judge;

    // Write YAML file
    const jsYaml = require('js-yaml');
    const yamlContent = jsYaml.dump(evalDef, { lineWidth: 120 });
    fs.writeFileSync(filePath, yamlContent, 'utf8');

    // Validate by loading back through loadEval — if invalid, delete and return 400
    try {
      loadEval(filePath);
    } catch (validationErr) {
      try { fs.unlinkSync(filePath); } catch (_) {}
      return res.status(400).json({ error: `Eval validation failed: ${validationErr.message}` });
    }

    res.status(201).json({ file_path: filePath, eval_name: sanitizedName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /folders/:projectId/author — AI-authored eval (async, progress via WebSocket)
router.post('/folders/:projectId/author', async (req, res) => {
  try {
    const { description, folderPath, refinement, currentFormState, hints } = req.body;

    if (!description || typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ error: 'description is required' });
    }
    if (!folderPath || typeof folderPath !== 'string' || !folderPath.trim()) {
      return res.status(400).json({ error: 'folderPath is required' });
    }

    const { getProject } = await getProjectDiscovery();
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Path safety check
    const projectRoot = project.root_path.endsWith('/') ? project.root_path : project.root_path + '/';
    if (!folderPath.startsWith(projectRoot) && folderPath !== project.root_path) {
      return res.status(400).json({ error: 'folderPath must be inside the project' });
    }

    const jobId = uuidv4();
    // Respond immediately — authoring runs in background
    res.json({ success: true, jobId });

    // Run authoring in background
    (async () => {
      const { broadcastToAll } = require('../websocket');
      const timers = [];

      try {
        // Send started event immediately
        broadcastToAll({ type: 'eval_authoring_started', jobId });

        // Schedule progress messages at predetermined intervals
        const progressMessages = [
          { delay: 8000, message: 'Investigating the codebase…' },
          { delay: 16000, message: 'Drafting the eval definition…' },
          { delay: 30000, message: 'Finalizing and validating…' },
        ];
        for (const { delay, message } of progressMessages) {
          timers.push(setTimeout(() => {
            broadcastToAll({ type: 'eval_authoring_progress', jobId, message });
          }, delay));
        }

        const { runAuthoring } = await getEvalAuthoring();
        const result = await runAuthoring({
          description,
          folderPath,
          projectRoot: project.root_path,
          missionControlConfig: project.config || null,
          refinement: refinement || null,
          currentFormState: currentFormState || null,
          hints: hints || null,
        });

        // Clear progress timers
        for (const t of timers) clearTimeout(t);

        if (result.error) {
          broadcastToAll({ type: 'eval_authoring_error', jobId, error: result.error });
        } else {
          broadcastToAll({
            type: 'eval_authoring_complete',
            jobId,
            eval: result.eval,
            reasoning: result.reasoning,
          });
        }
      } catch (err) {
        for (const t of timers) clearTimeout(t);
        broadcastToAll({ type: 'eval_authoring_error', jobId, error: err.message });
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /folders/:projectId/preview — synchronously run a single eval definition, return result
router.post('/folders/:projectId/preview', async (req, res) => {
  try {
    const { evalDefinition } = req.body;

    if (!evalDefinition || typeof evalDefinition !== 'object' || Array.isArray(evalDefinition)) {
      return res.status(400).json({ error: 'evalDefinition is required and must be an object' });
    }

    const { getProject } = await getProjectDiscovery();
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { runSingleEval } = await getEvalRunner();

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

    // Build DB readonly connection factory
    const { Client } = require('@neondatabase/serverless');
    const context = {
      projectRoot: project.root_path,
      commitSha,
      triggerSource: 'preview',
      dbReadonlyUrl: process.env.DATABASE_URL_READONLY || null,
      createDbConnection: async (url) => {
        const client = new Client({ connectionString: url });
        await client.connect();
        return client;
      },
      sessionLogPath: null,
      buildOutputPath: null,
      prDiffPath: null,
      variables: {
        input: evalDefinition.input || {},
        eval: { name: evalDefinition.name },
        run: { commit_sha: commitSha, trigger: 'preview' },
        project: { root: project.root_path },
      },
      input: evalDefinition.input || {},
      eval: { name: evalDefinition.name },
      run: { commit_sha: commitSha, trigger: 'preview' },
      project: { root: project.root_path },
    };

    const startTime = Date.now();
    const result = await runSingleEval(evalDefinition, context);
    const duration = Date.now() - startTime;

    // Estimate token cost from evidence and judge_prompt
    const evidenceStr = typeof result.evidence === 'string' ? result.evidence : JSON.stringify(result.evidence || '');
    const judgePromptStr = evalDefinition.judge_prompt || '';
    const estimatedTokenCost = Math.ceil(evidenceStr.length / 4) + Math.ceil(judgePromptStr.length / 4) + 500;

    res.json({
      success: true,
      result: { ...result, duration, estimatedTokenCost },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /folders/:projectId/publish — promote a .draft file to a live eval
router.post('/folders/:projectId/publish', async (req, res) => {
  try {
    const { draftPath } = req.body;

    if (!draftPath || typeof draftPath !== 'string' || !draftPath.trim()) {
      return res.status(400).json({ error: 'draftPath is required' });
    }

    const { getProject } = await getProjectDiscovery();
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Path safety check
    const projectRoot = project.root_path.endsWith('/') ? project.root_path : project.root_path + '/';
    if (!draftPath.startsWith(projectRoot) && draftPath !== project.root_path) {
      return res.status(400).json({ error: 'draftPath must be inside the project' });
    }

    const fs = require('fs');
    if (!fs.existsSync(draftPath)) {
      return res.status(404).json({ error: 'Draft file not found' });
    }
    if (!draftPath.endsWith('.draft')) {
      return res.status(400).json({ error: 'draftPath must end with .draft' });
    }

    // Determine target path (drop .draft suffix)
    const path = require('path');
    let targetPath = draftPath.slice(0, -'.draft'.length);

    // Auto-suffix if target already exists
    if (fs.existsSync(targetPath)) {
      const ext = path.extname(targetPath);
      const base = targetPath.slice(0, -ext.length);
      let counter = 2;
      while (fs.existsSync(`${base}-${counter}${ext}`)) {
        counter++;
      }
      targetPath = `${base}-${counter}${ext}`;
    }

    fs.renameSync(draftPath, targetPath);

    const evalName = path.basename(targetPath, path.extname(targetPath));
    res.json({ success: true, publishedPath: targetPath, evalName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /folders/:projectId/draft — delete a draft eval file
router.delete('/folders/:projectId/draft', async (req, res) => {
  try {
    const { draftPath } = req.body;

    if (!draftPath || typeof draftPath !== 'string' || !draftPath.trim()) {
      return res.status(400).json({ error: 'draftPath is required' });
    }

    const { getProject } = await getProjectDiscovery();
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Path safety check
    const projectRoot = project.root_path.endsWith('/') ? project.root_path : project.root_path + '/';
    if (!draftPath.startsWith(projectRoot) && draftPath !== project.root_path) {
      return res.status(400).json({ error: 'draftPath must be inside the project' });
    }

    const fs = require('fs');
    if (!fs.existsSync(draftPath)) {
      return res.status(404).json({ error: 'Draft file not found' });
    }
    if (!draftPath.endsWith('.draft')) {
      return res.status(400).json({ error: 'draftPath must end with .draft' });
    }

    fs.unlinkSync(draftPath);
    res.json({ success: true });
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

    const updated = result.rows[0];
    res.json(updated);

    // Auto-start PR watcher if any armed folder now has pr_updated trigger
    if (updated && updated.triggers && updated.triggers.includes('pr_updated')) {
      try {
        const { getProject } = await getProjectDiscovery();
        const { startPrWatcher, isWatching } = await getPrWatcher();
        if (!isWatching(req.params.projectId)) {
          const project = await getProject(req.params.projectId);
          if (project) {
            startPrWatcher(req.params.projectId, project.root_path, (projectId) => {
              triggerEvalRun(projectId, 'pr_updated', null, null);
            });
          }
        }
      } catch (e) {
        console.warn('[Evals] Failed to auto-start PR watcher:', e.message);
      }
    }
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

// POST /pr-watch/:projectId/start — start PR watching for a project
router.post('/pr-watch/:projectId/start', async (req, res) => {
  try {
    const { getProject } = await getProjectDiscovery();
    const { startPrWatcher, isWatching } = await getPrWatcher();

    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (isWatching(req.params.projectId)) {
      return res.json({ status: 'already_watching' });
    }

    startPrWatcher(req.params.projectId, project.root_path, (projectId) => {
      triggerEvalRun(projectId, 'pr_updated', null, null);
    });

    res.json({ status: 'started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /pr-watch/:projectId/stop — stop PR watching for a project
router.post('/pr-watch/:projectId/stop', async (req, res) => {
  try {
    const { stopPrWatcher } = await getPrWatcher();
    stopPrWatcher(req.params.projectId);
    res.json({ status: 'stopped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /pr-watch/:projectId/status — check if PR watching is active
router.get('/pr-watch/:projectId/status', async (req, res) => {
  try {
    const { isWatching } = await getPrWatcher();
    res.json({ watching: isWatching(req.params.projectId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /run/:runId — single run detail
router.get('/run/:runId', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM eval_runs WHERE id = $1',
      [req.params.runId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Run not found' });
    }
    res.json(result.rows[0]);
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
      // Use Neon's Client (WebSocket-based) instead of neon() (HTTP-based)
      // because the evidence gatherer wraps queries in a read-only transaction,
      // which requires a persistent connection that HTTP requests can't provide.
      const { Client } = require('@neondatabase/serverless');
      const baseContext = {
        projectRoot: project.root_path,
        commitSha,
        triggerSource,
        // DB readonly connection — required for db_query evidence
        dbReadonlyUrl: process.env.DATABASE_URL_READONLY || null,
        createDbConnection: async (url) => {
          const client = new Client({ connectionString: url });
          await client.connect();
          return client;
        },
        // Session log path — capture tmux scrollback if session is available
        sessionLogPath: null,
        buildOutputPath: null,
        prDiffPath: null,
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

      // If triggered by pr_updated, capture the PR diff via gh CLI
      if (triggerSource === 'pr_updated') {
        try {
          const { execSync } = require('child_process');
          const os = require('os');
          const fs = require('fs');
          const diffPath = require('path').join(os.tmpdir(), `eval-pr-diff-${batchId}.txt`);
          const diff = execSync('gh pr diff', {
            cwd: project.root_path,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 15000,
          });
          fs.writeFileSync(diffPath, diff, 'utf8');
          baseContext.prDiffPath = diffPath;
        } catch (e) {
          // gh CLI not available or no PR in context — pr_diff source will error gracefully
        }
      }

      // Run all evals in parallel per spec
      const results = await Promise.all(allEvals.map(async ({ evalDef, folder }) => {
        // Per-eval context: inject the eval's input map as variables for interpolation
        const context = {
          ...baseContext,
          variables: {
            input: evalDef.input || {},
            eval: { name: evalDef.name },
            run: { commit_sha: commitSha, trigger: triggerSource },
            project: { root: project.root_path },
          },
          input: evalDef.input || {},
          eval: { name: evalDef.name },
          run: { commit_sha: commitSha, trigger: triggerSource },
          project: { root: project.root_path },
        };
        const result = await runSingleEval(evalDef, context);
        result.evalFolder = folder.folder_path;
        // Attach the human-readable expected outcome for failure reporting
        if (evalDef.expected) result.expected = evalDef.expected;
        return { result, evalDef, folder };
      }));

      // Store all runs in DB (sequential to avoid connection pressure)
      for (const { result, evalDef, folder } of results) {
        const runId = uuidv4();
        await query(
          `INSERT INTO eval_runs (id, batch_id, eval_name, eval_folder, commit_sha, trigger_source, input, evidence, check_results, judge_verdict, state, fail_reason, error_message, duration)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            runId, batchId, result.evalName, folder.folder_path, commitSha, triggerSource,
            evalDef.input ? JSON.stringify(evalDef.input) : null,
            result.evidence != null ? (typeof result.evidence === 'string' ? result.evidence : JSON.stringify(result.evidence)) : null,
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
      const flatResults = results.map(r => r.result);
      const passed = flatResults.filter(r => r.state === 'pass').length;
      const failed = flatResults.filter(r => r.state === 'fail').length;
      const errored = flatResults.filter(r => r.state === 'error').length;

      // Update batch
      await query(
        `UPDATE eval_batches SET total = $1, passed = $2, failed = $3, errors = $4, completed_at = NOW(), status = 'complete'
         WHERE id = $5`,
        [flatResults.length, passed, failed, errored, batchId]
      );

      const summary = { batchId, total: flatResults.length, passed, failed, errors: errored, status: 'complete' };

      // Run retention cleanup after batch completes
      try { await cleanupOldRuns(projectId); } catch (e) { console.warn('[Evals] Retention cleanup failed:', e.message); }

      return { ...summary, results: flatResults };
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

/**
 * Retention cleanup: delete eval runs older than retention_days, but always keep
 * the most recent retention_runs per eval name (whichever is larger).
 * Defaults: 90 days, 100 runs. Configurable per project via settings.evals.retention_days / retention_runs.
 * Runs after each batch completes.
 */
async function cleanupOldRuns(projectId) {
  // Read project retention settings
  let retentionDays = 90;
  let retentionRuns = 100;
  try {
    const settingsResult = await query(
      "SELECT settings->'evals'->'retention_days' AS days, settings->'evals'->'retention_runs' AS runs FROM projects WHERE id = $1",
      [projectId]
    );
    if (settingsResult.rows.length > 0) {
      const row = settingsResult.rows[0];
      if (row.days != null) retentionDays = parseInt(row.days, 10) || 90;
      if (row.runs != null) retentionRuns = parseInt(row.runs, 10) || 100;
    }
  } catch (e) {
    // Fall back to defaults if settings query fails
  }

  // Delete runs that are both:
  //   1. Older than retention_days
  //   2. NOT in the top retention_runs most recent runs for that eval_name in this project
  await query(`
    DELETE FROM eval_runs WHERE id IN (
      SELECT er.id FROM eval_runs er
      JOIN eval_batches eb ON er.batch_id = eb.id
      WHERE eb.project_id = $1
        AND er.timestamp < NOW() - INTERVAL '1 day' * $2
        AND er.id NOT IN (
          SELECT id FROM (
            SELECT er2.id,
              ROW_NUMBER() OVER (PARTITION BY er2.eval_name ORDER BY er2.timestamp DESC) AS rn
            FROM eval_runs er2
            JOIN eval_batches eb2 ON er2.batch_id = eb2.id
            WHERE eb2.project_id = $1
          ) ranked WHERE rn <= $3
        )
    )
  `, [projectId, retentionDays, retentionRuns]);

  // Also clean up empty batches (all runs deleted)
  await query(`
    DELETE FROM eval_batches
    WHERE project_id = $1
      AND id NOT IN (SELECT DISTINCT batch_id FROM eval_runs)
  `, [projectId]);
}

module.exports = router;
module.exports.triggerEvalRun = triggerEvalRun;
module.exports.executeBatch = executeBatch;
