const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { query } = require('../database');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts', 'pipeline');
const STAGE_FILES = {
  1: 'spec_refinement.md',
  2: 'qa_design.md',
  3: 'implementation_planning.md',
  4: 'implementation.md',
  5: 'qa_execution.md',
  6: 'code_review.md',
  7: 'fix_cycle.md',
};
const ALL_STAGES = [1, 2, 3, 4, 5, 6, 7];

// The hash suffix prevents collisions when two pipelines share a name.
// Without it, the second pipeline reuses the first's branch and `git push`
// is rejected as non-fast-forward, so PR creation fails.
function sanitizeBranchName(name, pipelineId) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  const suffix = String(pipelineId || '').replace(/^pipe_/, '').slice(-8)
    || crypto.randomBytes(4).toString('hex');
  return `pipeline-${slug || 'unnamed'}-${suffix}`;
}

function loadDefaultPrompt(stage) {
  const file = STAGE_FILES[stage];
  if (!file) return '';
  const fullPath = path.join(PROMPTS_DIR, file);
  if (!fs.existsSync(fullPath)) return '';
  return fs.readFileSync(fullPath, 'utf8');
}

// Stages 4 (chunked implementation) and 7 (fix cycle) follow internal flows
// that do not fall through the gating pause point, so they cannot be gated.
const GATEABLE_STAGES = [1, 2, 3, 5, 6];

function normalizeGatedStages(input) {
  // Default mirrors prior hard-coded behavior: gate stages 1, 2, 3.
  if (input === undefined || input === null) return [1, 2, 3];
  if (!Array.isArray(input)) {
    throw new Error('gatedStages must be an array of stage numbers');
  }
  const cleaned = [];
  for (const raw of input) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 7) {
      throw new Error(`gatedStages must contain integers between 1 and 7 (got ${raw})`);
    }
    if (!GATEABLE_STAGES.includes(n)) continue; // silently drop non-gateable stages
    if (!cleaned.includes(n)) cleaned.push(n);
  }
  cleaned.sort((a, b) => a - b);
  return cleaned;
}

async function createPipeline({ projectId, name, specInput, gatedStages }) {
  if (!projectId) throw new Error('projectId required');
  if (!name) throw new Error('name required');
  if (!specInput) throw new Error('specInput required');

  const id = `pipe_${crypto.randomBytes(8).toString('hex')}`;
  const branchName = sanitizeBranchName(name, id);
  const stages = normalizeGatedStages(gatedStages);

  const result = await query(
    `INSERT INTO pipelines (id, name, project_id, branch_name, status, spec_input, gated_stages)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6::jsonb)
     RETURNING *`,
    [id, name, projectId, branchName, specInput, JSON.stringify(stages)]
  );
  const pipeline = hydratePipelineRow(result.rows[0]);

  for (const stage of ALL_STAGES) {
    await query(
      `INSERT INTO pipeline_stage_prompts (pipeline_id, stage, prompt) VALUES ($1, $2, $3)
       ON CONFLICT (pipeline_id, stage) DO NOTHING`,
      [id, stage, loadDefaultPrompt(stage)]
    );
  }

  return pipeline;
}

// JSONB columns sometimes round-trip as strings depending on the driver path.
// Normalize so consumers always get a JS array.
function hydratePipelineRow(row) {
  if (!row) return row;
  if (typeof row.gated_stages === 'string') {
    try { row.gated_stages = JSON.parse(row.gated_stages); }
    catch { row.gated_stages = [1, 2, 3]; }
  }
  if (!Array.isArray(row.gated_stages)) row.gated_stages = [1, 2, 3];
  return row;
}

async function getPipeline(pipelineId) {
  const result = await query('SELECT * FROM pipelines WHERE id = $1', [pipelineId]);
  return hydratePipelineRow(result.rows[0]) || null;
}

async function listPipelines(projectId) {
  const result = await query(
    'SELECT * FROM pipelines WHERE project_id = $1 ORDER BY created_at DESC',
    [projectId]
  );
  return result.rows.map(hydratePipelineRow);
}

async function updateStatus(pipelineId, { status, currentStage, prUrl, prCreationError, completedAt, worktreePath }) {
  const fields = [];
  const values = [];
  let idx = 1;
  if (status !== undefined) { fields.push(`status = $${idx++}`); values.push(status); }
  if (currentStage !== undefined) { fields.push(`current_stage = $${idx++}`); values.push(currentStage); }
  if (prUrl !== undefined) { fields.push(`pr_url = $${idx++}`); values.push(prUrl); }
  if (prCreationError !== undefined) { fields.push(`pr_creation_error = $${idx++}`); values.push(prCreationError); }
  if (completedAt !== undefined) { fields.push(`completed_at = $${idx++}`); values.push(completedAt); }
  if (worktreePath !== undefined) { fields.push(`worktree_path = $${idx++}`); values.push(worktreePath); }
  fields.push(`updated_at = NOW()`);
  values.push(pipelineId);
  await query(
    `UPDATE pipelines SET ${fields.join(', ')} WHERE id = $${idx}`,
    values
  );
}

async function recordStageOutput({ pipelineId, stage, iteration, outputPath }) {
  const result = await query(
    `INSERT INTO pipeline_stage_outputs (pipeline_id, stage, iteration, output_path, status)
     VALUES ($1, $2, $3, $4, 'completed')
     RETURNING *`,
    [pipelineId, stage, iteration, outputPath]
  );
  return result.rows[0];
}

async function listStageOutputs(pipelineId) {
  const result = await query(
    `SELECT * FROM pipeline_stage_outputs WHERE pipeline_id = $1
     ORDER BY stage ASC, iteration DESC`,
    [pipelineId]
  );
  return result.rows;
}

async function getLatestStageOutput(pipelineId, stage) {
  const result = await query(
    `SELECT * FROM pipeline_stage_outputs WHERE pipeline_id = $1 AND stage = $2
     ORDER BY iteration DESC LIMIT 1`,
    [pipelineId, stage]
  );
  return result.rows[0] || null;
}

async function approveStageOutput(pipelineId, stage) {
  await query(
    `UPDATE pipeline_stage_outputs SET status = 'approved', approved_at = NOW()
     WHERE id = (
       SELECT id FROM pipeline_stage_outputs
       WHERE pipeline_id = $1 AND stage = $2
       ORDER BY iteration DESC LIMIT 1
     )`,
    [pipelineId, stage]
  );
}

async function rejectStageOutput(pipelineId, stage) {
  await query(
    `UPDATE pipeline_stage_outputs SET status = 'rejected'
     WHERE id = (
       SELECT id FROM pipeline_stage_outputs
       WHERE pipeline_id = $1 AND stage = $2
       ORDER BY iteration DESC LIMIT 1
     )`,
    [pipelineId, stage]
  );
}

async function getStagePrompts(pipelineId) {
  const result = await query(
    'SELECT stage, prompt FROM pipeline_stage_prompts WHERE pipeline_id = $1',
    [pipelineId]
  );
  const out = {};
  for (const row of result.rows) {
    out[String(row.stage)] = row.prompt;
  }
  return out;
}

async function updateStagePrompt(pipelineId, stage, prompt) {
  await query(
    `INSERT INTO pipeline_stage_prompts (pipeline_id, stage, prompt, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (pipeline_id, stage) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = NOW()`,
    [pipelineId, stage, prompt]
  );
}

async function createChunks(pipelineId, chunks) {
  for (const chunk of chunks) {
    await query(
      `INSERT INTO pipeline_chunks
         (pipeline_id, chunk_index, name, body, files, qa_scenarios, dependencies, complexity, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       ON CONFLICT (pipeline_id, chunk_index) DO NOTHING`,
      [
        pipelineId,
        chunk.index,
        chunk.name,
        chunk.body,
        chunk.files || '',
        chunk.qaScenarios || '',
        chunk.dependencies || '',
        chunk.complexity || '',
      ]
    );
  }
}

async function listChunks(pipelineId) {
  const result = await query(
    `SELECT * FROM pipeline_chunks WHERE pipeline_id = $1 ORDER BY chunk_index ASC`,
    [pipelineId]
  );
  return result.rows;
}

async function getNextPendingChunk(pipelineId) {
  const result = await query(
    `SELECT * FROM pipeline_chunks WHERE pipeline_id = $1 AND status = 'pending'
     ORDER BY chunk_index ASC LIMIT 1`,
    [pipelineId]
  );
  return result.rows[0] || null;
}

async function markChunkRunning(pipelineId, chunkIndex, sessionId) {
  await query(
    `UPDATE pipeline_chunks SET status = 'running', session_id = $1, started_at = NOW()
     WHERE pipeline_id = $2 AND chunk_index = $3`,
    [sessionId, pipelineId, chunkIndex]
  );
}

async function markChunkCompleted(pipelineId, chunkIndex) {
  await query(
    `UPDATE pipeline_chunks SET status = 'completed', completed_at = NOW()
     WHERE pipeline_id = $1 AND chunk_index = $2`,
    [pipelineId, chunkIndex]
  );
}

async function findChunkBySessionId(sessionId) {
  const result = await query(
    `SELECT * FROM pipeline_chunks WHERE session_id = $1 LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] || null;
}

async function findActiveSessionForStage(pipelineId, stage) {
  const result = await query(
    `SELECT id FROM sessions
     WHERE pipeline_id = $1 AND pipeline_stage = $2 AND status != 'ended'
     ORDER BY created_at DESC LIMIT 1`,
    [pipelineId, stage]
  );
  return result.rows[0]?.id || null;
}

async function incrementFixCycleCount(pipelineId) {
  const result = await query(
    `UPDATE pipelines SET fix_cycle_count = COALESCE(fix_cycle_count, 0) + 1
     WHERE id = $1
     RETURNING fix_cycle_count`,
    [pipelineId]
  );
  return result.rows[0]?.fix_cycle_count ?? 0;
}

async function createEscalation({ pipelineId, stage, summary, detail }) {
  const id = `pesc_${crypto.randomBytes(8).toString('hex')}`;
  const result = await query(
    `INSERT INTO pipeline_escalations (id, pipeline_id, stage, summary, detail, status)
     VALUES ($1, $2, $3, $4, $5, 'open')
     RETURNING *`,
    [id, pipelineId, stage, summary, detail || null]
  );
  return result.rows[0];
}

async function listOpenEscalations(pipelineId) {
  const result = await query(
    `SELECT * FROM pipeline_escalations WHERE pipeline_id = $1 AND status = 'open'
     ORDER BY created_at DESC`,
    [pipelineId]
  );
  return result.rows;
}

async function resolveEscalation(escalationId) {
  await query(
    `UPDATE pipeline_escalations SET status = 'resolved', resolved_at = NOW()
     WHERE id = $1`,
    [escalationId]
  );
}

module.exports = {
  sanitizeBranchName,
  loadDefaultPrompt,
  normalizeGatedStages,
  GATEABLE_STAGES,
  createPipeline,
  getPipeline,
  listPipelines,
  updateStatus,
  recordStageOutput,
  listStageOutputs,
  getLatestStageOutput,
  approveStageOutput,
  rejectStageOutput,
  getStagePrompts,
  updateStagePrompt,
  createChunks,
  listChunks,
  getNextPendingChunk,
  markChunkRunning,
  markChunkCompleted,
  findChunkBySessionId,
  findActiveSessionForStage,
  incrementFixCycleCount,
  createEscalation,
  listOpenEscalations,
  resolveEscalation,
};
