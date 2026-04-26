const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { query } = require('../database');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts', 'pipeline');
const STAGE_FILES = {
  1: 'spec_refinement.md',
  2: 'qa_design.md',
  3: 'implementation_planning.md',
};

function sanitizeBranchName(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return `pipeline-${slug || 'unnamed'}`;
}

function loadDefaultPrompt(stage) {
  const file = STAGE_FILES[stage];
  if (!file) return '';
  const fullPath = path.join(PROMPTS_DIR, file);
  if (!fs.existsSync(fullPath)) return '';
  return fs.readFileSync(fullPath, 'utf8');
}

async function createPipeline({ projectId, name, specInput }) {
  if (!projectId) throw new Error('projectId required');
  if (!name) throw new Error('name required');
  if (!specInput) throw new Error('specInput required');

  const id = `pipe_${crypto.randomBytes(8).toString('hex')}`;
  const branchName = sanitizeBranchName(name);

  const result = await query(
    `INSERT INTO pipelines (id, name, project_id, branch_name, status, spec_input)
     VALUES ($1, $2, $3, $4, 'draft', $5)
     RETURNING *`,
    [id, name, projectId, branchName, specInput]
  );
  const pipeline = result.rows[0];

  for (const stage of [1, 2, 3]) {
    await query(
      `INSERT INTO pipeline_stage_prompts (pipeline_id, stage, prompt) VALUES ($1, $2, $3)
       ON CONFLICT (pipeline_id, stage) DO NOTHING`,
      [id, stage, loadDefaultPrompt(stage)]
    );
  }

  return pipeline;
}

async function getPipeline(pipelineId) {
  const result = await query('SELECT * FROM pipelines WHERE id = $1', [pipelineId]);
  return result.rows[0] || null;
}

async function listPipelines(projectId) {
  const result = await query(
    'SELECT * FROM pipelines WHERE project_id = $1 ORDER BY created_at DESC',
    [projectId]
  );
  return result.rows;
}

async function updateStatus(pipelineId, { status, currentStage, prUrl, completedAt }) {
  const fields = [];
  const values = [];
  let idx = 1;
  if (status !== undefined) { fields.push(`status = $${idx++}`); values.push(status); }
  if (currentStage !== undefined) { fields.push(`current_stage = $${idx++}`); values.push(currentStage); }
  if (prUrl !== undefined) { fields.push(`pr_url = $${idx++}`); values.push(prUrl); }
  if (completedAt !== undefined) { fields.push(`completed_at = $${idx++}`); values.push(completedAt); }
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

async function getActivePipelineForProject(projectId) {
  const result = await query(
    `SELECT * FROM pipelines WHERE project_id = $1
     AND status NOT IN ('completed', 'failed', 'draft')
     ORDER BY created_at DESC LIMIT 1`,
    [projectId]
  );
  return result.rows[0] || null;
}

module.exports = {
  sanitizeBranchName,
  loadDefaultPrompt,
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
  getActivePipelineForProject,
};
