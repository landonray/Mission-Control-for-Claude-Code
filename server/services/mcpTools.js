const fs = require('fs');
const path = require('path');
const { query } = require('../database');
const orchestrator = require('./planningSessionOrchestrator');
const sessionManager = require('./sessionManager');
const pipelineRepo = require('./pipelineRepo');
const pipelineRuntime = require('./pipelineRuntime');
const evalsRoute = require('../routes/evals');

function unwrapDefault(mod) {
  return mod && mod.default && typeof mod.default === 'object' ? mod.default : mod;
}

// Lazy ESM getters routed through module.exports so tests can stub them.
// Tests cannot intercept dynamic `import()` from a CJS module via vi.mock,
// so the indirection through module.exports gives us a clean test seam.
let _evalLoader;
async function _getEvalLoader() {
  if (!_evalLoader) _evalLoader = unwrapDefault(await import('./evalLoader.js'));
  return _evalLoader;
}

let _evalAuthoring;
async function _getEvalAuthoring() {
  if (!_evalAuthoring) _evalAuthoring = unwrapDefault(await import('./evalAuthoring.js'));
  return _evalAuthoring;
}

/**
 * Tool handlers for the Mission Control MCP server (Phase 1).
 *
 * Tokens are app-wide: every tool call (other than mc_list_projects) requires
 * an explicit project_id arg. Claude Code is expected to call mc_list_projects
 * first to discover available projects.
 */

async function assertProjectExists(projectId) {
  const result = await query('SELECT id FROM projects WHERE id = $1', [projectId]);
  if (result.rows.length === 0) {
    throw new Error(`Project not found: ${projectId}`);
  }
}

async function loadProject(projectId) {
  const result = await query(
    'SELECT id, name, root_path FROM projects WHERE id = $1',
    [projectId]
  );
  if (result.rows.length === 0) {
    throw new Error(`Project not found: ${projectId}`);
  }
  return result.rows[0];
}

// Resolve a caller-supplied relative path against the project's root_path and
// confirm it stays inside the root. Rejects absolute paths, ".." escapes, and
// symlinks that resolve outside the root. Returns the absolute joined path
// (not the realpath — callers compute relative paths against root_path).
function resolveProjectPath(rootPath, relPath) {
  if (!rootPath) {
    throw new Error('Project has no root_path configured.');
  }
  const root = path.resolve(rootPath);
  const rel = String(relPath ?? '').trim();
  // Treat empty / "/" / "." as the project root itself.
  if (rel === '' || rel === '/' || rel === '.') {
    return root;
  }
  // Anything else that looks absolute is rejected outright; we only accept
  // paths the caller explicitly framed as relative to the project root.
  if (path.isAbsolute(rel) || rel.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rel)) {
    throw new Error('path must be relative to the project root.');
  }
  const joined = path.resolve(root, rel);
  if (joined !== root && !joined.startsWith(root + path.sep)) {
    throw new Error('path resolves outside the project root.');
  }
  // If the path exists, follow symlinks and ensure the real target is still
  // inside the root. Compare realpath-to-realpath because /var on macOS is a
  // symlink to /private/var, so a naive prefix check would fail.
  try {
    const real = fs.realpathSync(joined);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error('path resolves outside the project root via symlink.');
    }
  } catch (err) {
    // ENOENT just means the path doesn't exist yet — fine for write operations.
    if (err.code !== 'ENOENT') throw err;
  }
  return joined;
}

const FILE_LIST_IGNORES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
]);

function listProjectTree(absDir, rootPath, depth, maxDepth) {
  if (depth > maxDepth) return [];
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    return [{ name: '<unreadable>', path: path.relative(rootPath, absDir), type: 'error', error: err.code || err.message }];
  }
  const filtered = entries.filter((e) => {
    if (FILE_LIST_IGNORES.has(e.name)) return false;
    if (e.name.startsWith('.') && e.name !== '.env.example') return false;
    return true;
  });
  filtered.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });
  const out = [];
  for (const entry of filtered) {
    const full = path.join(absDir, entry.name);
    const rel = path.relative(rootPath, full);
    if (entry.isDirectory()) {
      const node = { name: entry.name, path: rel, type: 'dir' };
      if (depth < maxDepth) {
        node.children = listProjectTree(full, rootPath, depth + 1, maxDepth);
      } else {
        node.children_truncated = true;
      }
      out.push(node);
    } else if (entry.isFile()) {
      let size = null;
      try { size = fs.statSync(full).size; } catch (_) {}
      out.push({ name: entry.name, path: rel, type: 'file', size });
    }
  }
  return out;
}

const FILE_READ_MAX_BYTES = 1024 * 1024; // 1 MB cap on file reads via MCP.

function isProbablyBinary(buf) {
  // Sniff first 4KB for NUL bytes — a cheap heuristic that handles the common cases.
  const slice = buf.slice(0, Math.min(buf.length, 4096));
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0) return true;
  }
  return false;
}

const WRITABLE_CONTEXT_DOCS = {
  product: 'PRODUCT.md',
  architecture: 'ARCHITECTURE.md',
};

function readDescription(rootPath) {
  if (!rootPath) return null;
  // PRODUCT.md is the canonical project context doc (slice 3 will create
  // these). README.md is the next best fallback. CLAUDE.md is intentionally
  // last because it usually leads with user/instruction content rather than
  // a description of the project itself.
  const candidates = ['PRODUCT.md', 'README.md', 'CLAUDE.md'];
  for (const file of candidates) {
    try {
      const abs = path.join(rootPath, file);
      if (!fs.existsSync(abs)) continue;
      const content = fs.readFileSync(abs, 'utf8');
      // First non-heading paragraph, capped at 240 chars.
      const lines = content.split('\n');
      const paragraph = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          if (paragraph.length > 0) break;
          continue;
        }
        if (trimmed.startsWith('#')) continue;
        paragraph.push(trimmed);
      }
      if (paragraph.length === 0) continue;
      const text = paragraph.join(' ').replace(/\s+/g, ' ');
      return text.length > 240 ? text.slice(0, 237).trimEnd() + '…' : text;
    } catch (_) {
      // ignore unreadable files
    }
  }
  return null;
}

async function listProjectsTool(_args, _ctx) {
  const result = await query(
    `SELECT id, name, root_path, github_repo, deployment_url, last_deploy_status
     FROM projects ORDER BY name ASC`
  );
  return {
    projects: result.rows.map((row) => {
      const productMd = row.root_path ? path.join(row.root_path, 'PRODUCT.md') : null;
      const archMd = row.root_path ? path.join(row.root_path, 'ARCHITECTURE.md') : null;
      const decisionsMd = row.root_path ? path.join(row.root_path, 'docs', 'decisions.md') : null;
      return {
        id: row.id,
        name: row.name,
        root_path: row.root_path,
        github_repo: row.github_repo || null,
        deployment_url: row.deployment_url || null,
        last_deploy_status: row.last_deploy_status || null,
        description: readDescription(row.root_path),
        product_md_exists: productMd ? fs.existsSync(productMd) : false,
        architecture_md_exists: archMd ? fs.existsSync(archMd) : false,
        decisions_md_exists: decisionsMd ? fs.existsSync(decisionsMd) : false,
      };
    }),
  };
}

async function startSessionTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required. Call mc_list_projects to discover available projects.');
  }
  await assertProjectExists(args.project_id);

  const sessionType = args.session_type || 'planning';
  const allowedTypes = ['planning', 'implementation', 'extraction', 'eval_gatherer'];
  if (!allowedTypes.includes(sessionType)) {
    throw new Error(`session_type must be one of: ${allowedTypes.join(', ')} (got "${sessionType}")`);
  }
  if (!args.task || !String(args.task).trim()) {
    throw new Error('task is required');
  }

  if (sessionType === 'implementation') {
    const project = await loadProject(args.project_id);
    const initialPrompt = args.system_prompt
      ? `${String(args.system_prompt).trim()}\n\n${String(args.task).trim()}`
      : String(args.task).trim();
    const session = await sessionManager.createSession({
      name: `Implementation: ${String(args.task).trim().slice(0, 80)}`,
      workingDirectory: project.root_path,
      permissionMode: 'auto',
      useWorktree: true,
      sessionType: 'implementation',
      askingSessionId: args.asking_session_id || null,
      projectId: args.project_id,
      initialPrompt,
    });
    return {
      session_id: session.id,
      status: session.status,
      planning_question_id: null,
      session_type: 'implementation',
    };
  }

  const result = await orchestrator.startPlanningSession({
    projectId: args.project_id,
    systemPrompt: args.system_prompt || null,
    task: args.task,
    contextFiles: args.context_files || [],
    timeoutSeconds: args.timeout_seconds,
    askingSessionId: args.asking_session_id || null,
    workingFiles: args.working_files || null,
  });
  return {
    session_id: result.sessionId,
    status: result.status,
    planning_question_id: result.planningQuestionId,
    session_type: sessionType,
  };
}

async function sendMessageTool(args, _ctx) {
  if (!args.session_id) throw new Error('session_id is required');
  if (!args.message || !String(args.message).trim()) throw new Error('message is required');

  await orchestrator.deliverMessage(args.session_id, args.message, {
    askingSessionId: args.asking_session_id || null,
    workingFiles: args.working_files || null,
  });
  return {
    status: 'delivered',
    session_id: args.session_id,
    instructions: `Message delivered to session ${args.session_id}. The session is now processing asynchronously. To check progress, call \`mc_get_session_status\` with this session_id. Once status is complete, call \`mc_get_session_summary\` to get the full result.`,
  };
}

async function getStatusTool(args, _ctx) {
  if (!args.session_id) throw new Error('session_id is required');
  const status = await orchestrator.getStatus(args.session_id);
  if (!status) throw new Error(`Session ${args.session_id} not found`);
  return {
    session_id: status.sessionId,
    status: status.status,
    duration_seconds: Math.round(status.durationSeconds * 100) / 100,
    last_response: status.lastResponse,
    session_type: status.sessionType,
  };
}

const CONTEXT_DOCS = {
  product: 'PRODUCT.md',
  architecture: 'ARCHITECTURE.md',
};

function readContextDoc(rootPath, filename) {
  if (!rootPath) {
    return { exists: false, path: null, content: null };
  }
  const abs = path.join(rootPath, filename);
  if (!fs.existsSync(abs)) {
    return { exists: false, path: abs, content: null };
  }
  try {
    return { exists: true, path: abs, content: fs.readFileSync(abs, 'utf8') };
  } catch (err) {
    return { exists: false, path: abs, content: null, error: err.message };
  }
}

async function getProjectContextTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required. Call mc_list_projects to discover available projects.');
  }
  const which = (args.document || 'both').toLowerCase();
  if (!['product', 'architecture', 'both'].includes(which)) {
    throw new Error(`document must be one of: product, architecture, both (got "${args.document}")`);
  }

  const result = await query(
    'SELECT id, name, root_path FROM projects WHERE id = $1',
    [args.project_id]
  );
  if (result.rows.length === 0) {
    throw new Error(`Project not found: ${args.project_id}`);
  }
  const project = result.rows[0];

  const out = {
    project_id: project.id,
    project_name: project.name,
    root_path: project.root_path,
  };
  if (which === 'product' || which === 'both') {
    out.product = readContextDoc(project.root_path, CONTEXT_DOCS.product);
  }
  if (which === 'architecture' || which === 'both') {
    out.architecture = readContextDoc(project.root_path, CONTEXT_DOCS.architecture);
  }
  return out;
}

async function listProjectFilesTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required. Call mc_list_projects to discover available projects.');
  }
  const project = await loadProject(args.project_id);
  const requestedPath = args.path || '';
  const requestedDepth = args.depth === undefined ? 3 : Number(args.depth);
  if (!Number.isFinite(requestedDepth) || requestedDepth < 1) {
    throw new Error('depth must be a positive integer.');
  }
  const maxDepth = Math.min(Math.floor(requestedDepth), 10);

  const absDir = resolveProjectPath(project.root_path, requestedPath);
  let stat;
  try {
    stat = fs.statSync(absDir);
  } catch (err) {
    throw new Error(`path not found: ${requestedPath || '/'}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`path is not a directory: ${requestedPath}`);
  }

  const tree = listProjectTree(absDir, path.resolve(project.root_path), 1, maxDepth);
  return {
    project_id: project.id,
    project_name: project.name,
    root_path: project.root_path,
    path: path.relative(path.resolve(project.root_path), absDir) || '',
    depth: maxDepth,
    tree,
  };
}

async function readProjectFileTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required. Call mc_list_projects to discover available projects.');
  }
  if (!args.path || !String(args.path).trim()) {
    throw new Error('path is required (relative to the project root).');
  }
  const project = await loadProject(args.project_id);
  const abs = resolveProjectPath(project.root_path, args.path);

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    throw new Error(`File not found: ${args.path}`);
  }
  if (stat.isDirectory()) {
    throw new Error(`path is a directory, not a file: ${args.path}. Use mc_list_project_files to list directory contents.`);
  }

  const buf = fs.readFileSync(abs);
  const totalSize = buf.length;
  const truncated = totalSize > FILE_READ_MAX_BYTES;
  const slice = truncated ? buf.slice(0, FILE_READ_MAX_BYTES) : buf;
  const binary = isProbablyBinary(slice);

  const out = {
    project_id: project.id,
    path: path.relative(path.resolve(project.root_path), abs),
    abs_path: abs,
    size: totalSize,
    truncated,
    encoding: binary ? 'base64' : 'utf8',
    content: binary ? slice.toString('base64') : slice.toString('utf8'),
  };
  if (binary) {
    out.note = 'File appears to be binary; content is base64-encoded.';
  }
  if (truncated) {
    out.note = (out.note ? out.note + ' ' : '') + `File is larger than ${FILE_READ_MAX_BYTES} bytes; only the first ${FILE_READ_MAX_BYTES} bytes are returned.`;
  }
  return out;
}

async function writeProjectContextTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required. Call mc_list_projects to discover available projects.');
  }
  const which = String(args.document || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(WRITABLE_CONTEXT_DOCS, which)) {
    throw new Error('document must be one of: product, architecture.');
  }
  if (typeof args.content !== 'string') {
    throw new Error('content is required and must be a string.');
  }
  const project = await loadProject(args.project_id);
  if (!project.root_path) {
    throw new Error('Project has no root_path configured; cannot write context document.');
  }

  const filename = WRITABLE_CONTEXT_DOCS[which];
  const abs = resolveProjectPath(project.root_path, filename);
  const existed = fs.existsSync(abs);
  fs.writeFileSync(abs, args.content, 'utf8');
  const stat = fs.statSync(abs);

  return {
    project_id: project.id,
    document: which,
    path: filename,
    abs_path: abs,
    bytes_written: stat.size,
    created: !existed,
    updated: existed,
  };
}

async function startPipelineTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required. Call mc_list_projects to discover available projects.');
  }
  if (!args.name || !String(args.name).trim()) {
    throw new Error('name is required (a short label for the pipeline).');
  }
  const hasSpec = !!args.spec;
  const hasSpecFile = !!args.spec_file;

  if (hasSpec && hasSpecFile) {
    throw new Error('Provide either spec or spec_file, not both.');
  }
  if (!hasSpec && !hasSpecFile) {
    throw new Error('spec or spec_file is required.');
  }

  let specInput;

  if (hasSpecFile) {
    const rootResult = await query('SELECT root_path FROM projects WHERE id = $1', [args.project_id]);
    if (rootResult.rows.length === 0) {
      throw new Error(`Project not found: ${args.project_id}`);
    }
    const rootPath = rootResult.rows[0].root_path;
    const resolvedPath = path.resolve(rootPath, args.spec_file);
    if (!resolvedPath.startsWith(rootPath + '/')) {
      throw new Error('spec_file must be within the project directory.');
    }
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`spec_file not found: ${args.spec_file}`);
    }
    specInput = fs.readFileSync(resolvedPath, 'utf8');
  } else {
    await assertProjectExists(args.project_id);
    specInput = args.spec;
  }

  const orch = pipelineRuntime.getOrchestrator();
  const pipeline = await orch.createAndStart({
    projectId: args.project_id,
    name: args.name,
    specInput,
    gatedStages: args.gated_stages,
  });
  return {
    pipeline_id: pipeline.id,
    name: pipeline.name,
    status: pipeline.status,
    current_stage: pipeline.current_stage,
    branch_name: pipeline.branch_name,
    gated_stages: pipeline.gated_stages,
  };
}

async function getPipelineStatusTool(args, _ctx) {
  if (!args.pipeline_id) throw new Error('pipeline_id is required');
  const pipeline = await pipelineRepo.getPipeline(args.pipeline_id);
  if (!pipeline) throw new Error(`Pipeline ${args.pipeline_id} not found`);
  const outputs = await pipelineRepo.listStageOutputs(pipeline.id);
  const chunks = await pipelineRepo.listChunks(pipeline.id);
  const escalations = await pipelineRepo.listOpenEscalations(pipeline.id);
  return {
    pipeline_id: pipeline.id,
    name: pipeline.name,
    status: pipeline.status,
    current_stage: pipeline.current_stage,
    fix_cycle_count: pipeline.fix_cycle_count || 0,
    branch_name: pipeline.branch_name,
    completed_at: pipeline.completed_at,
    outputs: outputs.map((o) => ({
      stage: o.stage, iteration: o.iteration, output_path: o.output_path, status: o.status,
    })),
    chunks: chunks.map((c) => ({
      chunk_index: c.chunk_index, name: c.name, status: c.status,
    })),
    escalations: escalations.map((e) => ({ stage: e.stage, summary: e.summary, detail: e.detail })),
  };
}

async function approveStageTool(args, _ctx) {
  if (!args.pipeline_id) throw new Error('pipeline_id is required');
  await pipelineRuntime.approveAndBroadcast(args.pipeline_id);
  const pipeline = await pipelineRepo.getPipeline(args.pipeline_id);
  return { ok: true, current_stage: pipeline.current_stage, status: pipeline.status };
}

async function rejectStageTool(args, _ctx) {
  if (!args.pipeline_id) throw new Error('pipeline_id is required');
  if (!args.feedback || !String(args.feedback).trim()) {
    throw new Error('feedback is required (a concrete description of what to change).');
  }
  await pipelineRuntime.rejectAndBroadcast(args.pipeline_id, args.feedback);
  const pipeline = await pipelineRepo.getPipeline(args.pipeline_id);
  return { ok: true, current_stage: pipeline.current_stage, status: pipeline.status };
}

async function loadProjectWithConfig(projectId) {
  const result = await query(
    'SELECT id, name, root_path, config FROM projects WHERE id = $1',
    [projectId]
  );
  if (result.rows.length === 0) {
    throw new Error(`Project not found: ${projectId}`);
  }
  return result.rows[0];
}

function relativeToProject(rootPath, abs) {
  return path.relative(path.resolve(rootPath), abs);
}

async function listEvalsTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required. Call mc_list_projects to discover available projects.');
  }
  const project = await loadProjectWithConfig(args.project_id);
  if (!project.root_path) {
    throw new Error('Project has no root_path configured.');
  }

  const { discoverEvalFolders, loadEvalFolder, loadDraftsFromFolder } = await module.exports._getEvalLoader();
  const folderPaths = discoverEvalFolders(project.root_path, project.config);

  const armedResult = await query(
    'SELECT folder_path, triggers, auto_send FROM eval_armed_folders WHERE project_id = $1',
    [project.id]
  );
  const armedMap = new Map(armedResult.rows.map((r) => [r.folder_path, r]));

  const folders = folderPaths.map((fp) => {
    const folder_name = path.basename(fp);
    const armed = armedMap.get(fp);
    let evals = [];
    let drafts = [];
    try {
      evals = loadEvalFolder(fp).map((ev) => ({
        name: ev.name,
        description: ev.description,
        evidence_type: ev.evidence?.type || null,
        file_path: relativeToProject(project.root_path, ev._source),
        is_draft: false,
      }));
    } catch (_) {}
    try {
      drafts = loadDraftsFromFolder(fp).map((ev) => ({
        name: ev.name,
        description: ev.description,
        evidence_type: ev.evidence?.type || null,
        file_path: relativeToProject(project.root_path, ev._source),
        is_draft: true,
      }));
    } catch (_) {}
    return {
      folder_path: relativeToProject(project.root_path, fp),
      folder_name,
      armed: !!armed,
      triggers: armed ? armed.triggers : null,
      auto_send: armed ? armed.auto_send === 1 : false,
      evals: [...evals, ...drafts],
    };
  });

  return {
    project_id: project.id,
    project_name: project.name,
    folders,
  };
}

async function armFolderTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required.');
  }
  if (!args.folder_path || !String(args.folder_path).trim()) {
    throw new Error('folder_path is required (relative to the project root).');
  }
  if (typeof args.armed !== 'boolean') {
    throw new Error('armed is required (true to arm, false to disarm).');
  }
  const project = await loadProjectWithConfig(args.project_id);
  const absFolder = resolveProjectPath(project.root_path, args.folder_path);

  if (!fs.existsSync(absFolder) || !fs.statSync(absFolder).isDirectory()) {
    throw new Error(`folder_path does not exist or is not a directory: ${args.folder_path}`);
  }

  if (!args.armed) {
    await query(
      'DELETE FROM eval_armed_folders WHERE project_id = $1 AND folder_path = $2',
      [project.id, absFolder]
    );
    return { project_id: project.id, folder_path: args.folder_path, armed: false };
  }

  const folder_name = path.basename(absFolder);
  const triggers = args.triggers || 'manual';
  const auto_send = args.auto_send === true ? 1 : 0;
  const { v4: uuidv4 } = require('uuid');
  const id = uuidv4();
  const result = await query(
    `INSERT INTO eval_armed_folders (id, project_id, folder_path, folder_name, triggers, auto_send)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id, folder_path) DO UPDATE
       SET folder_name = EXCLUDED.folder_name,
           triggers = EXCLUDED.triggers,
           auto_send = EXCLUDED.auto_send
     RETURNING *`,
    [id, project.id, absFolder, folder_name, triggers, auto_send]
  );
  const row = result.rows[0];
  return {
    project_id: project.id,
    folder_path: args.folder_path,
    folder_name: row.folder_name,
    armed: true,
    triggers: row.triggers,
    auto_send: row.auto_send === 1,
  };
}

async function runEvalsTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required.');
  }
  const result = await evalsRoute.executeBatch(args.project_id, 'mcp_client', null, null);
  return {
    project_id: args.project_id,
    batch_id: result.batchId || null,
    total: result.total || 0,
    passed: result.passed || 0,
    failed: result.failed || 0,
    errors: result.errors || 0,
    status: result.status || 'no_armed_folders',
    message: result.message || null,
    results: (result.results || []).map((r) => ({
      eval_name: r.evalName,
      eval_folder: r.evalFolder,
      state: r.state,
      fail_reason: r.failReason || null,
      duration_ms: r.duration || 0,
    })),
  };
}

async function getEvalResultsTool(args, _ctx) {
  if (!args.batch_id) {
    throw new Error('batch_id is required.');
  }
  const batchResult = await query(
    'SELECT * FROM eval_batches WHERE id = $1',
    [args.batch_id]
  );
  if (batchResult.rows.length === 0) {
    throw new Error(`Batch ${args.batch_id} not found`);
  }
  const batch = batchResult.rows[0];
  const runsResult = await query(
    'SELECT * FROM eval_runs WHERE batch_id = $1 ORDER BY timestamp ASC',
    [args.batch_id]
  );
  return {
    batch_id: batch.id,
    project_id: batch.project_id,
    trigger_source: batch.trigger_source,
    status: batch.status,
    total: batch.total,
    passed: batch.passed,
    failed: batch.failed,
    errors: batch.errors,
    started_at: batch.started_at,
    completed_at: batch.completed_at,
    runs: runsResult.rows.map((r) => ({
      eval_name: r.eval_name,
      eval_folder: r.eval_folder,
      state: r.state,
      fail_reason: r.fail_reason,
      error_message: r.error_message,
      duration_ms: r.duration,
      timestamp: r.timestamp,
    })),
  };
}

async function authorEvalTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required.');
  }
  if (!args.folder_path || !String(args.folder_path).trim()) {
    throw new Error('folder_path is required (relative to the project root).');
  }
  if (!args.description || !String(args.description).trim()) {
    throw new Error('description is required (a plain-English description of what to check).');
  }
  const project = await loadProjectWithConfig(args.project_id);
  const absFolder = resolveProjectPath(project.root_path, args.folder_path);
  if (!fs.existsSync(absFolder) || !fs.statSync(absFolder).isDirectory()) {
    throw new Error(`folder_path does not exist or is not a directory: ${args.folder_path}`);
  }

  const { runAuthoring } = await module.exports._getEvalAuthoring();
  const result = await runAuthoring({
    description: args.description,
    folderPath: absFolder,
    projectRoot: project.root_path,
    missionControlConfig: project.config || null,
    refinement: null,
    currentFormState: null,
    hints: args.hints || null,
  });

  if (result.error) {
    throw new Error(`Eval authoring failed: ${result.error}`);
  }
  if (!result.eval) {
    throw new Error('Eval authoring produced no eval definition.');
  }

  const evalDef = result.eval;
  const sanitizedName = String(evalDef.name || 'eval').trim().replace(/[^a-zA-Z0-9]+/g, '_');
  const filePath = path.join(absFolder, sanitizedName + '.yaml');
  if (fs.existsSync(filePath)) {
    throw new Error(`An eval with name "${evalDef.name}" already exists at ${relativeToProject(project.root_path, filePath)}. Pick a different description or call mc_delete_eval first.`);
  }

  const jsYaml = require('js-yaml');
  const yamlContent = jsYaml.dump(evalDef, { lineWidth: 120 });
  fs.writeFileSync(filePath, yamlContent, 'utf8');

  const { loadEval } = await module.exports._getEvalLoader();
  try {
    loadEval(filePath);
  } catch (validationErr) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    throw new Error(`Authored eval failed validation and was discarded: ${validationErr.message}`);
  }

  return {
    project_id: project.id,
    file_path: relativeToProject(project.root_path, filePath),
    eval_name: evalDef.name,
    description: evalDef.description,
    evidence_type: evalDef.evidence?.type || null,
    reasoning: result.reasoning || null,
    eval: evalDef,
  };
}

async function editEvalTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required.');
  }
  if (!args.file_path || !String(args.file_path).trim()) {
    throw new Error('file_path is required (relative to the project root).');
  }
  if (!args.name || !String(args.name).trim()) throw new Error('name is required');
  if (!args.description || !String(args.description).trim()) throw new Error('description is required');
  if (!args.evidence || typeof args.evidence !== 'object' || Array.isArray(args.evidence)) {
    throw new Error('evidence is required and must be an object');
  }
  if (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)) {
    throw new Error('input is required and must be a key-value map');
  }
  if (!args.checks && !args.judge_prompt) {
    throw new Error('At least one of "checks" or "judge_prompt" is required');
  }
  if (args.judge_prompt && !args.expected) {
    throw new Error('"expected" is required when "judge_prompt" is provided');
  }

  const project = await loadProjectWithConfig(args.project_id);
  const abs = resolveProjectPath(project.root_path, args.file_path);
  const isYaml = abs.endsWith('.yaml') || abs.endsWith('.yml') ||
                 abs.endsWith('.yaml.draft') || abs.endsWith('.yml.draft');
  if (!isYaml) {
    throw new Error('file_path must reference a .yaml, .yml, .yaml.draft, or .yml.draft file');
  }
  if (!fs.existsSync(abs)) {
    throw new Error(`Eval file not found: ${args.file_path}`);
  }

  const { VALID_EVIDENCE_TYPES, VALID_CHECK_TYPES, loadEval } = await module.exports._getEvalLoader();
  if (!args.evidence.type || !VALID_EVIDENCE_TYPES.includes(args.evidence.type)) {
    throw new Error(`Invalid evidence type "${args.evidence.type}" — must be one of ${VALID_EVIDENCE_TYPES.join(', ')}`);
  }
  if (args.checks && Array.isArray(args.checks)) {
    for (const check of args.checks) {
      if (check.type && !VALID_CHECK_TYPES.includes(check.type)) {
        throw new Error(`Invalid check type "${check.type}" — must be one of ${VALID_CHECK_TYPES.join(', ')}`);
      }
    }
  }

  const priorContent = fs.readFileSync(abs, 'utf8');
  const evalDef = {
    name: String(args.name).trim(),
    description: String(args.description).trim(),
    evidence: args.evidence,
    input: args.input,
  };
  if (args.checks) evalDef.checks = args.checks;
  if (args.judge_prompt) evalDef.judge_prompt = args.judge_prompt;
  if (args.expected) evalDef.expected = args.expected;
  if (args.judge) evalDef.judge = args.judge;

  const jsYaml = require('js-yaml');
  fs.writeFileSync(abs, jsYaml.dump(evalDef, { lineWidth: 120 }), 'utf8');
  try {
    loadEval(abs);
  } catch (validationErr) {
    try { fs.writeFileSync(abs, priorContent, 'utf8'); } catch (_) {}
    throw new Error(`Eval validation failed: ${validationErr.message}`);
  }

  return {
    project_id: project.id,
    file_path: args.file_path,
    eval_name: evalDef.name,
  };
}

async function deleteEvalTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required.');
  }
  if (!args.file_path || !String(args.file_path).trim()) {
    throw new Error('file_path is required (relative to the project root).');
  }
  const project = await loadProjectWithConfig(args.project_id);
  const abs = resolveProjectPath(project.root_path, args.file_path);
  const isYaml = abs.endsWith('.yaml') || abs.endsWith('.yml') ||
                 abs.endsWith('.yaml.draft') || abs.endsWith('.yml.draft');
  if (!isYaml) {
    throw new Error('file_path must reference a .yaml, .yml, .yaml.draft, or .yml.draft file');
  }
  if (!fs.existsSync(abs)) {
    throw new Error(`Eval file not found: ${args.file_path}`);
  }
  fs.unlinkSync(abs);
  return {
    project_id: project.id,
    file_path: args.file_path,
    deleted: true,
  };
}

async function getEvalSchemaTool(_args, _ctx) {
  const authoring = await module.exports._getEvalAuthoring();
  const loader = await module.exports._getEvalLoader();
  const { EVIDENCE_TYPES, CHECK_TYPES } = authoring;
  const { VALID_EVIDENCE_TYPES, VALID_CHECK_TYPES } = loader;

  const evidenceList = Object.entries(EVIDENCE_TYPES).map(([type, info]) => ({
    type,
    description: info.description,
    fields: Object.entries(info.fields).map(([name, desc]) => ({ name, description: desc })),
  }));
  const checkList = Object.entries(CHECK_TYPES).map(([type, info]) => ({
    type,
    description: info.description,
    fields: Object.entries(info.fields).map(([name, desc]) => ({ name, description: desc })),
  }));

  const exampleYaml = `name: readme_has_heading
description: Verifies the README contains a top-level heading
evidence:
  type: file
  path: README.md
input: {}
checks:
  - type: regex_match
    pattern: '^# '
`;

  return {
    valid_evidence_types: VALID_EVIDENCE_TYPES,
    valid_check_types: VALID_CHECK_TYPES,
    evidence_types: evidenceList,
    check_types: checkList,
    judge: {
      description: 'Use as an alternative to (or alongside) checks for fuzzy / qualitative criteria. Provide judge_prompt + expected. Optionally set judge.model to one of: default, fast, strong.',
      required_fields_when_used: ['judge_prompt', 'expected'],
      optional_fields: { 'judge.model': "One of 'default' | 'fast' | 'strong' (defaults to 'default')." },
    },
    variables: [
      { name: '${input.<key>}', description: "Any field from the eval's input map (e.g. ${input.user_id})." },
      { name: '${eval.name}', description: 'The eval name.' },
      { name: '${run.commit_sha}', description: "The git short-SHA of the run's commit." },
      { name: '${run.trigger}', description: "What kicked off the run (e.g. 'manual', 'session_end', 'pr_updated', 'mcp_client')." },
      { name: '${project.root}', description: 'Absolute path to the project root.' },
    ],
    required_fields: ['name', 'description', 'evidence', 'input'],
    one_of_required: ['checks', 'judge_prompt'],
    rules: [
      'Either checks or judge_prompt (or both) must be provided.',
      "When judge_prompt is set, 'expected' is required.",
      "input must be an object (use {} when there are no input variables).",
      'evidence.type must be one of valid_evidence_types.',
      'Each check.type must be one of valid_check_types.',
    ],
    example: exampleYaml,
  };
}

async function searchSessionsTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required.');
  }
  if (!args.query || !String(args.query).trim()) {
    throw new Error('query is required (a substring or keyword to match against session content).');
  }
  await assertProjectExists(args.project_id);

  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);
  const sessionTypeFilter = args.session_type || null;
  const pattern = '%' + String(args.query).trim() + '%';

  const params = [args.project_id, pattern];
  let sql = `
    SELECT
      s.id, s.name, s.session_type, s.status, s.created_at, s.ended_at,
      s.last_action_summary, s.pipeline_id, s.pipeline_stage,
      ss.summary, ss.files_modified, ss.key_actions,
      pq.question AS planning_question,
      p.pr_url AS pipeline_pr_url
    FROM sessions s
    LEFT JOIN LATERAL (
      SELECT summary, files_modified, key_actions
      FROM session_summaries
      WHERE session_id = s.id
      ORDER BY created_at DESC
      LIMIT 1
    ) ss ON TRUE
    LEFT JOIN planning_questions pq ON pq.planning_session_id = s.id OR pq.asking_session_id = s.id
    LEFT JOIN pipelines p ON p.id = s.pipeline_id
    WHERE s.project_id = $1
      AND (
        s.name ILIKE $2
        OR s.last_action_summary ILIKE $2
        OR ss.summary ILIKE $2
        OR pq.question ILIKE $2
      )
  `;
  if (sessionTypeFilter) {
    params.push(sessionTypeFilter);
    sql += ` AND s.session_type = $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY s.created_at DESC LIMIT $${params.length}`;

  const result = await query(sql, params);
  return {
    project_id: args.project_id,
    query: args.query,
    session_type: sessionTypeFilter,
    limit,
    count: result.rows.length,
    sessions: result.rows.map((r) => {
      let filesModified = null;
      if (r.files_modified) {
        try {
          filesModified = typeof r.files_modified === 'string'
            ? JSON.parse(r.files_modified)
            : r.files_modified;
        } catch (_) {}
      }
      return {
        session_id: r.id,
        name: r.name,
        session_type: r.session_type,
        status: r.status,
        created_at: r.created_at,
        ended_at: r.ended_at,
        last_action_summary: r.last_action_summary,
        summary: r.summary || null,
        files_touched: filesModified,
        planning_question: r.planning_question || null,
        pipeline_id: r.pipeline_id,
        pipeline_stage: r.pipeline_stage,
        pr_url: r.pipeline_pr_url || null,
      };
    }),
  };
}

async function getSessionSummaryTool(args, _ctx) {
  if (!args.session_id) {
    throw new Error('session_id is required.');
  }
  const sessionResult = await query(
    `SELECT s.*, p.pr_url AS pipeline_pr_url
     FROM sessions s
     LEFT JOIN pipelines p ON p.id = s.pipeline_id
     WHERE s.id = $1`,
    [args.session_id]
  );
  if (sessionResult.rows.length === 0) {
    throw new Error(`Session ${args.session_id} not found`);
  }
  const session = sessionResult.rows[0];

  const summaryResult = await query(
    `SELECT summary, key_actions, files_modified, created_at
     FROM session_summaries
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [args.session_id]
  );
  const summary = summaryResult.rows[0] || null;

  let filesTouched = null;
  let keyActions = null;
  if (summary) {
    try {
      filesTouched = typeof summary.files_modified === 'string'
        ? JSON.parse(summary.files_modified)
        : summary.files_modified;
    } catch (_) {}
    try {
      keyActions = typeof summary.key_actions === 'string'
        ? JSON.parse(summary.key_actions)
        : summary.key_actions;
    } catch (_) {}
  }

  const planningResult = await query(
    `SELECT question, answer, status, asked_at, answered_at
     FROM planning_questions
     WHERE planning_session_id = $1 OR asking_session_id = $1
     ORDER BY asked_at ASC`,
    [args.session_id]
  );

  const evalBatchesResult = await query(
    `SELECT id, trigger_source, status, total, passed, failed, errors, started_at, completed_at
     FROM eval_batches
     WHERE session_id = $1
     ORDER BY started_at DESC`,
    [args.session_id]
  );

  return {
    session_id: session.id,
    name: session.name,
    session_type: session.session_type,
    status: session.status,
    project_id: session.project_id,
    pipeline_id: session.pipeline_id,
    pipeline_stage: session.pipeline_stage,
    pr_url: session.pipeline_pr_url || null,
    created_at: session.created_at,
    ended_at: session.ended_at,
    last_activity_at: session.last_activity_at,
    last_action_summary: session.last_action_summary,
    branch: session.branch,
    working_directory: session.working_directory,
    lines_added: session.lines_added,
    lines_removed: session.lines_removed,
    user_message_count: session.user_message_count,
    assistant_message_count: session.assistant_message_count,
    tool_call_count: session.tool_call_count,
    summary: summary ? summary.summary : null,
    summary_at: summary ? summary.created_at : null,
    key_actions: keyActions,
    files_touched: filesTouched,
    planning_questions: planningResult.rows.map((p) => ({
      question: p.question,
      answer: p.answer,
      status: p.status,
      asked_at: p.asked_at,
      answered_at: p.answered_at,
    })),
    eval_batches: evalBatchesResult.rows.map((b) => ({
      batch_id: b.id,
      trigger_source: b.trigger_source,
      status: b.status,
      total: b.total,
      passed: b.passed,
      failed: b.failed,
      errors: b.errors,
      started_at: b.started_at,
      completed_at: b.completed_at,
    })),
  };
}

async function recoverPipelineTool(args, _ctx) {
  if (!args.pipeline_id) throw new Error('pipeline_id is required');
  const pipeline = await pipelineRepo.getPipeline(args.pipeline_id);
  if (!pipeline) throw new Error(`Pipeline ${args.pipeline_id} not found`);
  const reconciled = await pipelineRuntime.reconcileStuckSessions({ pipelineId: args.pipeline_id });
  const refreshed = await pipelineRepo.getPipeline(args.pipeline_id);
  return {
    pipeline_id: args.pipeline_id,
    status: refreshed.status,
    current_stage: refreshed.current_stage,
    reconciled_sessions: reconciled.length,
    actions: reconciled.map((r) => ({
      session_id: r.sessionId,
      stage: r.stage,
      action: r.action,
      error: r.error,
    })),
  };
}

const TOOL_DEFINITIONS = [
  {
    name: 'mc_list_projects',
    description:
      'List all projects known to Mission Control so you can pick the right one before starting a session. Each project includes its name, repo path, GitHub repo (if linked), latest deployment status, a short description pulled from CLAUDE.md or README.md, and flags showing whether PRODUCT.md, ARCHITECTURE.md, and docs/decisions.md exist. Always call this first before mc_start_session.',
    inputSchema: { type: 'object', properties: {} },
    handler: listProjectsTool,
  },
  {
    name: 'mc_start_session',
    description:
      'Start a new Mission Control session in a specific project. Choose session_type based on what you need:\n\n' +
      '- "planning" (default): a read-only agent that answers a product or architectural question PRODUCT.md and ARCHITECTURE.md don\'t cover. It can escalate to the project owner via the decision log. Use this when you need an answer, not code changes.\n' +
      '- "implementation": a full-agency coding session that runs in its own worktree with permission_mode=auto and actually writes code. Use this when you want the work done, not planned. Equivalent to a manual session but kicked off via MCP.\n' +
      '- "extraction" / "eval_gatherer": internal session types primarily triggered automatically (extraction on PR merge, eval_gatherer when armed evals run). Rarely needed via this tool.\n\n' +
      'All sessions appear in the dashboard. Planning Q&A gets logged to docs/decisions.md. Call mc_list_projects first if you don\'t know which project_id to use.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required. Get this from mc_list_projects.' },
        session_type: {
          type: 'string',
          enum: ['planning', 'implementation', 'extraction', 'eval_gatherer'],
          description: 'Session type. Defaults to "planning". Use "implementation" to start a coding session that actually does the work (auto permissions, dedicated worktree).',
        },
        system_prompt: { type: 'string', description: 'Optional override for the agent\'s system prompt. For planning sessions this replaces the default planning prompt; for implementation sessions it is prepended to the task.' },
        task: { type: 'string', description: 'The question (for planning) or task description (for implementation) to give the agent. Required.' },
        context_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of project-relative file paths to load into the session\'s context. PRODUCT.md and ARCHITECTURE.md are auto-loaded — only specify additional files here.',
        },
        asking_session_id: { type: 'string', description: 'The ID of the implementation session asking this question (for decision-log linking).' },
        working_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files the asking session is currently working on. Logged into docs/decisions.md so reviewers can see what code prompted the question.',
        },
        timeout_seconds: { type: 'number', description: 'Optional cap on how long to wait for the session to respond. Omit (or 0) to wait indefinitely (recommended).' },
      },
      required: ['project_id', 'task'],
    },
    handler: startSessionTool,
  },
  {
    name: 'mc_send_message',
    description:
      'Send a message to any Mission Control session and return immediately — does not wait for the session to respond. Works whether the session is active or cold; cold sessions are automatically resumed before the message is delivered. Returns a confirmation with session_id and instructions for following up: use mc_get_session_status to poll progress, then mc_get_session_summary once complete. For planning sessions, decision logging runs in the background.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID. Can be a planning session from mc_start_session or any existing implementation session.' },
        message: { type: 'string', description: 'The message to send.' },
        asking_session_id: { type: 'string' },
        working_files: { type: 'array', items: { type: 'string' } },
      },
      required: ['session_id', 'message'],
    },
    handler: sendMessageTool,
  },
  {
    name: 'mc_get_session_status',
    description:
      'Check the status of a Mission Control session. For planning sessions, status="waiting_for_owner" means the planning agent escalated the question to the project owner — keep polling. status="completed" with last_response set means an answer is available (either from the planning agent or, in the case of an escalation, from the owner). status="dismissed" means the owner closed the escalation without answering.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
      },
      required: ['session_id'],
    },
    handler: getStatusTool,
  },
  {
    name: 'mc_get_project_context',
    description:
      "Fetch a project's context documents (PRODUCT.md and/or ARCHITECTURE.md) without starting a session. Use this when you need raw project context — e.g., a CI check, a webhook handler, or a quick lookup before deciding whether to escalate. For most product/architecture questions during a coding session, prefer mc_start_session with session_type='planning' so the question is logged as a decision.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required. Get this from mc_list_projects.' },
        document: {
          type: 'string',
          enum: ['product', 'architecture', 'both'],
          description: 'Which document to return. Defaults to "both".',
        },
      },
      required: ['project_id'],
    },
    handler: getProjectContextTool,
  },
  {
    name: 'mc_list_project_files',
    description:
      "List files and directories inside a project's repo. Returns a tree rooted at the requested subdirectory (default: project root). Hidden files, node_modules, .git, build artifacts, and virtual envs are excluded. Use this to explore project layout before reading files with mc_read_project_file.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required. Get this from mc_list_projects.' },
        path: { type: 'string', description: 'Relative path inside the project to list (e.g., "server/services"). Defaults to the project root.' },
        depth: { type: 'number', description: 'How many directory levels deep to walk. Defaults to 3, capped at 10.' },
      },
      required: ['project_id'],
    },
    handler: listProjectFilesTool,
  },
  {
    name: 'mc_read_project_file',
    description:
      "Read the contents of a file inside a project's repo. Path must be relative to the project root. UTF-8 text files are returned verbatim; binary files are returned base64-encoded. Files larger than 1 MB are truncated to the first 1 MB. Use mc_list_project_files first if you don't know the path.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required.' },
        path: { type: 'string', description: 'Relative path to the file inside the project (e.g., "server/index.js"). Required.' },
      },
      required: ['project_id', 'path'],
    },
    handler: readProjectFileTool,
  },
  {
    name: 'mc_write_project_context',
    description:
      "Write (create or replace) the project's PRODUCT.md or ARCHITECTURE.md at the project root. This is the only write tool exposed via MCP and is intentionally restricted to the two context documents. Pass document='product' or 'architecture' and the full new file content. Returns the bytes written and whether the file was created or updated.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required.' },
        document: {
          type: 'string',
          enum: ['product', 'architecture'],
          description: 'Which context document to write.',
        },
        content: { type: 'string', description: 'Full new contents of the file (UTF-8). Required.' },
      },
      required: ['project_id', 'document', 'content'],
    },
    handler: writeProjectContextTool,
  },
  {
    name: 'mc_start_pipeline',
    description:
      'Create and start a Mission Control pipeline that will take a raw spec through spec refinement, QA design, implementation planning, implementation, QA execution, code review, and (if needed) fix cycles. Approval gates are configured per-pipeline via gated_stages — at each gated stage the pipeline pauses for owner approval before continuing; non-gated stages run autonomously. Defaults to gating stages 1, 2, and 3. Stages 4 (chunked implementation) and 7 (fix cycle) are always autonomous and cannot be gated. Returns the pipeline_id; use mc_get_pipeline_status to track progress and mc_approve_stage / mc_reject_stage to act on gated stages. Provide the spec as raw text via spec, or as a project-relative path to a text/markdown file via spec_file when the spec already exists as a file in the project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required. Call mc_list_projects to discover available projects.' },
        name: { type: 'string', description: 'Short label for the pipeline (e.g. "Add pagination support"). Required.' },
        spec: { type: 'string', description: 'Raw spec text. Provide either this or spec_file, not both.' },
        spec_file: { type: 'string', description: "Project-relative path to a plain text or markdown file to use as the spec (e.g. 'docs/specs/my-feature.md'). Provide either spec or spec_file, not both." },
        gated_stages: {
          type: 'array',
          items: { type: 'integer', minimum: 1, maximum: 7 },
          description: 'Stage numbers (1-7) that should pause for owner approval. Stages 4 and 7 are always autonomous and are ignored if included. Defaults to [1, 2, 3].',
        },
      },
      required: ['project_id', 'name'],
    },
    handler: startPipelineTool,
  },
  {
    name: 'mc_get_pipeline_status',
    description:
      'Get the current state of a pipeline: status, current stage, stage outputs produced so far, chunk progress for stage 4, fix cycle count, and any open escalations the project owner needs to resolve. Status values: draft, running, paused_for_approval (gated stage waiting for the owner), paused_for_failure (output never produced), paused_for_escalation (fix cycle cap exceeded), completed, failed.',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string', description: 'Pipeline ID returned by mc_start_pipeline.' },
      },
      required: ['pipeline_id'],
    },
    handler: getPipelineStatusTool,
  },
  {
    name: 'mc_approve_stage',
    description:
      'Approve the current paused stage of a pipeline so it advances to the next stage. Only works when the pipeline is paused_for_approval. After mc_approve_stage on stage 3, the pipeline parses the build plan and starts the autonomous implementation phase.',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string' },
      },
      required: ['pipeline_id'],
    },
    handler: approveStageTool,
  },
  {
    name: 'mc_reject_stage',
    description:
      'Reject the current paused stage of a pipeline and re-run it with the supplied feedback added to the prompt. Only works when the pipeline is paused_for_approval. Use this when the stage output has the wrong shape or scope and you want the same stage to try again.',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string' },
        feedback: { type: 'string', description: 'What to change. Be specific so the next attempt addresses it.' },
      },
      required: ['pipeline_id', 'feedback'],
    },
    handler: rejectStageTool,
  },
  {
    name: 'mc_list_evals',
    description:
      "List all eval folders and individual evals for a project. Each folder reports whether it's armed, its trigger config, and the live + draft evals inside. Use this before authoring a new eval to avoid duplicates and to discover the folder_path you'll need for mc_arm_folder, mc_author_eval, mc_edit_eval, or mc_delete_eval. All paths are returned relative to the project root.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required.' },
      },
      required: ['project_id'],
    },
    handler: listEvalsTool,
  },
  {
    name: 'mc_arm_folder',
    description:
      "Arm or disarm an eval folder for a project. Armed folders run automatically on their configured triggers (manual, session_end, pr_updated). Pass armed=true to arm (with optional triggers like 'session_end,manual' and auto_send=true to feed failures back to the active CLI session) or armed=false to disarm. folder_path is relative to the project root — get it from mc_list_evals.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required.' },
        folder_path: { type: 'string', description: "Folder path relative to the project root (e.g., 'evals/recipe-extraction'). Required." },
        armed: { type: 'boolean', description: 'true to arm the folder, false to disarm. Required.' },
        triggers: { type: 'string', description: "Comma-separated trigger list when arming. Allowed values: 'manual', 'session_end', 'pr_updated'. Defaults to 'manual'." },
        auto_send: { type: 'boolean', description: 'When true, eval failures are sent back as a message to the originating CLI session. Defaults to false.' },
      },
      required: ['project_id', 'folder_path', 'armed'],
    },
    handler: armFolderTool,
  },
  {
    name: 'mc_run_evals',
    description:
      "Run all currently-armed eval folders for a project right now and block until every eval has reported a verdict. Use this after finishing a feature to verify nothing regressed before declaring work complete. Returns a batch_id and a per-eval summary; use mc_get_eval_results with the batch_id to fetch the full results later. Returns immediately with status='no_armed_folders' if nothing is armed.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required.' },
      },
      required: ['project_id'],
    },
    handler: runEvalsTool,
  },
  {
    name: 'mc_get_eval_results',
    description:
      "Fetch the full results of a previously-completed eval batch by batch_id. Returns the batch summary (totals, status) plus every run with its verdict, fail_reason, and timing. Useful when mc_run_evals returned a batch_id and you want to inspect failures or compare against history.",
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: { type: 'string', description: 'Batch ID returned by mc_run_evals or shown in the dashboard. Required.' },
      },
      required: ['batch_id'],
    },
    handler: getEvalResultsTool,
  },
  {
    name: 'mc_author_eval',
    description:
      "Author a new eval from a plain-English description. Mission Control's eval-authoring agent reads the description against the project's codebase, drafts a structured YAML eval (evidence source, checks, optional LLM judge prompt), and writes it to disk as a published .yaml file in the specified folder. Returns the created eval. Use this when you observe a quality concern worth checking on every future change — e.g., 'every extracted recipe must have a non-empty ingredients list'. The eval starts unarmed; call mc_arm_folder afterward to activate it.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required.' },
        folder_path: { type: 'string', description: "Folder path relative to the project root where the new eval should be written (e.g., 'evals/recipe-extraction'). Required. The folder must already exist." },
        description: { type: 'string', description: "Plain-English description of what the eval should check. Be specific — describe the input, the expected behavior, and what counts as a failure. Required." },
        hints: { type: 'string', description: 'Optional additional hints for the authoring agent (e.g., known evidence sources, prior failure patterns).' },
      },
      required: ['project_id', 'folder_path', 'description'],
    },
    handler: authorEvalTool,
  },
  {
    name: 'mc_edit_eval',
    description:
      "Edit an existing eval in place. Provide the full new definition (name, description, evidence, input, plus checks and/or judge_prompt+expected) — this is a full replacement, not a diff. The file path is preserved (no rename). On validation failure the prior content is restored. Use this when you need to tighten a rubric or fix a bad evidence source; if you want to remove an eval entirely, use mc_delete_eval instead. If you don't have a working example to reference, call mc_get_eval_schema first to discover valid evidence types, check types, and required fields.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required.' },
        file_path: { type: 'string', description: 'Eval file path relative to the project root (.yaml, .yml, .yaml.draft, or .yml.draft). Required. Get it from mc_list_evals.' },
        name: { type: 'string', description: 'Eval name (human-readable identifier). Required.' },
        description: { type: 'string', description: 'One-line description of what this eval verifies. Required.' },
        evidence: { type: 'object', description: "Evidence source object. Must include 'type' (one of: log_query, db_query, sub_agent, file) plus type-specific fields. Required." },
        input: { type: 'object', description: 'Key-value map of input variables for interpolation into evidence and checks. Required (use empty object {} if none).' },
        checks: { type: 'array', description: 'Array of structural check objects. At least one of checks or judge_prompt is required.' },
        judge_prompt: { type: 'string', description: 'Optional natural-language rubric for an LLM judge. When provided, expected is required.' },
        expected: { type: 'string', description: 'Required when judge_prompt is provided. Describes the expected outcome the judge will compare evidence against.' },
        judge: { type: 'object', description: "Optional judge config (e.g., { model: 'fast' | 'default' | 'strong' })." },
      },
      required: ['project_id', 'file_path', 'name', 'description', 'evidence', 'input'],
    },
    handler: editEvalTool,
  },
  {
    name: 'mc_delete_eval',
    description:
      "Delete an eval file (live .yaml or .yaml.draft) from the project. Use this when an eval is wrong, redundant, or no longer relevant. file_path is relative to the project root and must end with .yaml, .yml, .yaml.draft, or .yml.draft. The folder's armed status is unchanged.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required.' },
        file_path: { type: 'string', description: 'Eval file path relative to the project root. Required. Get it from mc_list_evals.' },
      },
      required: ['project_id', 'file_path'],
    },
    handler: deleteEvalTool,
  },
  {
    name: 'mc_get_eval_schema',
    description:
      "Returns the canonical schema for an eval definition: every valid evidence type with its required and optional fields, every valid check type with its fields, judge configuration, variable interpolation rules, and a minimal example YAML. Call this before mc_edit_eval (or before constructing a YAML eval by hand) so you know exactly what fields are valid. Not needed for mc_author_eval, which has the schema baked into the authoring agent's prompt.",
    inputSchema: { type: 'object', properties: {} },
    handler: getEvalSchemaTool,
  },
  {
    name: 'mc_search_sessions',
    description:
      "Search past Mission Control sessions for a project by keyword. Performs a case-insensitive substring match across the session name, last action summary, the most recent session summary text, and the original planning question (for planning sessions). Returns a list of matching session summaries with id, type, status, files_touched, and pipeline / PR links. Use this to discover whether a topic has been worked on before — e.g., 'has anyone touched pagination?' — instead of asking the user.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required.' },
        query: { type: 'string', description: 'Keyword or phrase to match against session content. Required.' },
        session_type: {
          type: 'string',
          enum: ['implementation', 'planning', 'extraction', 'eval_gatherer'],
          description: 'Optional filter by session type.',
        },
        limit: { type: 'number', description: 'Maximum number of results to return. Defaults to 10, capped at 50.' },
      },
      required: ['project_id', 'query'],
    },
    handler: searchSessionsTool,
  },
  {
    name: 'mc_get_session_summary',
    description:
      "Fetch the full summary of a single session: status, summary text, key actions, files touched, planning questions asked and how they were answered, eval batches that ran for this session, plus any associated pipeline + PR URL. Use this to deeply understand what a previous session did before deciding whether to repeat its work or build on top of it. Pair with mc_search_sessions to first find the session, then drill in.",
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Mission Control session ID. Required. Get it from mc_search_sessions.' },
      },
      required: ['session_id'],
    },
    handler: getSessionSummaryTool,
  },
  {
    name: 'mc_recover_pipeline',
    description:
      "Reconcile a pipeline whose stage session was interrupted (e.g. by a server restart) and is now stuck. For each orphaned session it finds, this tool either records the produced output and advances the pipeline, or pauses the pipeline with a clear escalation if the work can't be safely resumed. Safe to call on a healthy pipeline — it's a no-op when there are no orphans. Use this if mc_get_pipeline_status shows a session stuck in 'working' but no progress is being made.",
    inputSchema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string', description: 'Pipeline ID to recover.' },
      },
      required: ['pipeline_id'],
    },
    handler: recoverPipelineTool,
  },
];

module.exports = {
  TOOL_DEFINITIONS,
  startSessionTool,
  sendMessageTool,
  getStatusTool,
  listProjectsTool,
  getProjectContextTool,
  readDescription,
  startPipelineTool,
  getPipelineStatusTool,
  approveStageTool,
  rejectStageTool,
  recoverPipelineTool,
  listProjectFilesTool,
  readProjectFileTool,
  writeProjectContextTool,
  listEvalsTool,
  armFolderTool,
  runEvalsTool,
  getEvalResultsTool,
  authorEvalTool,
  editEvalTool,
  deleteEvalTool,
  getEvalSchemaTool,
  searchSessionsTool,
  getSessionSummaryTool,
  resolveProjectPath,
  _getEvalLoader,
  _getEvalAuthoring,
};
