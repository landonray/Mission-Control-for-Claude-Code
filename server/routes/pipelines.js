const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const router = express.Router();
const repo = require('../services/pipelineRepo');
const runtime = require('../services/pipelineRuntime');
const { query } = require('../database');

// Read a stage output file. While the pipeline is running we read it from the
// per-pipeline worktree on disk. After PR creation the worktree is cleaned up,
// so fall back to reading the file out of the branch's git history.
function readStageOutputFile({ pipeline, projectRoot, outputPath }) {
  if (pipeline.worktree_path) {
    try { return fs.readFileSync(path.join(pipeline.worktree_path, outputPath), 'utf8'); }
    catch (_) { /* fall through to git */ }
  }
  if (projectRoot && pipeline.branch_name) {
    try {
      return execFileSync(
        'git',
        ['show', `${pipeline.branch_name}:${outputPath}`],
        { cwd: projectRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      );
    } catch (_) { /* not in branch — fall through */ }
  }
  if (projectRoot) {
    try { return fs.readFileSync(path.join(projectRoot, outputPath), 'utf8'); }
    catch (_) { /* best effort */ }
  }
  return '';
}

const STAGE_NAMES = {
  1: 'Spec Refinement',
  2: 'QA Design',
  3: 'Implementation Planning',
  4: 'Implementation',
  5: 'QA Execution',
  6: 'Code Review',
  7: 'Fix Cycle',
};

// decisionChat is an ESM module — load lazily to handle the CJS/ESM bridge.
function unwrapDefault(mod) {
  if (!mod) return mod;
  if (typeof mod.buildPipelineStagePrompt === 'function') return mod;
  if (mod.default && typeof mod.default === 'object') return mod.default;
  return mod;
}
let _decisionChat;
async function getDecisionChat() {
  if (!_decisionChat) {
    _decisionChat = unwrapDefault(await import('../services/decisionChat.js'));
  }
  return _decisionChat;
}

async function loadProjectDocs(projectRoot) {
  const read = (filename) => {
    if (!projectRoot) return '';
    const fp = path.join(projectRoot, 'docs', filename);
    try { return fs.readFileSync(fp, 'utf8'); } catch { return ''; }
  };
  return {
    productMd: read('PRODUCT.md'),
    architectureMd: read('ARCHITECTURE.md'),
    decisionsMd: read('decisions.md'),
  };
}

async function loadPipelineForApproval(pipelineId) {
  const pipeline = await repo.getPipeline(pipelineId);
  if (!pipeline) return { error: 'Pipeline not found', status: 404 };
  if (pipeline.status !== 'paused_for_approval') {
    return { error: 'Pipeline is not awaiting approval', status: 409 };
  }
  const stage = pipeline.current_stage;
  const output = await repo.getLatestStageOutput(pipelineId, stage);
  const projectRow = await query('SELECT root_path FROM projects WHERE id = $1', [pipeline.project_id]);
  const projectRoot = projectRow.rows[0]?.root_path;
  let stageOutput = '';
  if (output && output.output_path) {
    stageOutput = readStageOutputFile({ pipeline, projectRoot, outputPath: output.output_path });
  }
  return {
    pipeline,
    stage: { stage, name: STAGE_NAMES[stage] || `Stage ${stage}`, output_path: output?.output_path || null },
    stageOutput,
    projectRoot,
  };
}

router.post('/', async (req, res) => {
  try {
    const { project_id, name, spec_input, gated_stages } = req.body || {};
    if (!project_id || !name || !spec_input) {
      return res.status(400).json({ error: 'project_id, name, and spec_input are required' });
    }
    const orchestrator = runtime.getOrchestrator();
    const pipeline = await orchestrator.createAndStart({
      projectId: project_id,
      name,
      specInput: spec_input,
      gatedStages: gated_stages,
    });
    res.status(201).json(pipeline);
  } catch (err) {
    console.error('POST /api/pipelines failed:', err);
    if (/gatedStages/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const projectId = req.query.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id query param required' });
    const pipelines = await repo.listPipelines(projectId);
    res.json({ pipelines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const pipeline = await repo.getPipeline(req.params.id);
    if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });
    const outputs = await repo.listStageOutputs(req.params.id);
    const prompts = await repo.getStagePrompts(req.params.id);
    const chunks = await repo.listChunks(req.params.id);
    const escalations = await repo.listOpenEscalations(req.params.id);
    const sessions = await query(
      `SELECT id, status, session_type, created_at, ended_at, pipeline_stage
       FROM sessions WHERE pipeline_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    const projectRow = await query(
      'SELECT github_repo FROM projects WHERE id = $1',
      [pipeline.project_id]
    );
    const github_repo = projectRow.rows[0]?.github_repo || null;
    res.json({ pipeline, outputs, prompts, chunks, escalations, sessions: sessions.rows, github_repo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    await runtime.approveAndBroadcast(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/create-pr', async (req, res) => {
  try {
    const pipeline = await repo.getPipeline(req.params.id);
    if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });
    if (pipeline.status !== 'completed') {
      return res.status(409).json({ error: 'Pipeline is not completed yet' });
    }
    const result = await runtime.createPrAndBroadcast(req.params.id);
    if (!result.ok) {
      return res.status(502).json({ error: result.error });
    }
    res.json({ ok: true, url: result.url, existed: result.existed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pipelines/:id/recover
// Reconcile any orphaned pipeline sessions for this pipeline. Used as an
// escape hatch when a session's tmux process died but its DB row is still
// stuck in 'working' (e.g. after an unclean server restart).
router.post('/:id/recover', async (req, res) => {
  try {
    const pipeline = await repo.getPipeline(req.params.id);
    if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });
    const reconciled = await runtime.reconcileStuckSessions({ pipelineId: req.params.id });
    res.json({ ok: true, reconciled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/reject', async (req, res) => {
  try {
    const feedback = req.body && req.body.feedback;
    if (!feedback || !String(feedback).trim()) {
      return res.status(400).json({ error: 'feedback is required' });
    }
    await runtime.rejectAndBroadcast(req.params.id, feedback);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id/prompts/:stage', async (req, res) => {
  try {
    const stage = Number(req.params.stage);
    if (![1, 2, 3, 4, 5, 6, 7].includes(stage)) {
      return res.status(400).json({ error: 'Stage must be between 1 and 7' });
    }
    const prompt = req.body && req.body.prompt;
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt is required' });
    await repo.updateStagePrompt(req.params.id, stage, prompt);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/output/:stage', async (req, res) => {
  try {
    const pipeline = await repo.getPipeline(req.params.id);
    if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });
    const stage = Number(req.params.stage);
    const output = await repo.getLatestStageOutput(req.params.id, stage);
    if (!output) return res.status(404).json({ error: 'No output for this stage yet' });
    const projectRow = await query('SELECT root_path FROM projects WHERE id = $1', [pipeline.project_id]);
    const projectRoot = projectRow.rows[0]?.root_path;
    const content = readStageOutputFile({ pipeline, projectRoot, outputPath: output.output_path });
    if (!content) return res.status(404).json({ error: 'Output file missing on disk' });
    res.json({ content, output_path: output.output_path, status: output.status, iteration: output.iteration });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pipelines/:id/approval-chat
// Returns the chat history for the current paused stage.
router.get('/:id/approval-chat', async (req, res) => {
  try {
    const ctx = await loadPipelineForApproval(req.params.id);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const subjectId = `${ctx.pipeline.id}:${ctx.stage.stage}`;
    const result = await query(
      `SELECT id, role, content, created_at FROM decision_chats
       WHERE subject_type = 'pipeline_stage' AND subject_id = $1
       ORDER BY created_at ASC`,
      [subjectId]
    );
    res.json({
      stage: ctx.stage,
      pipeline: { id: ctx.pipeline.id, name: ctx.pipeline.name, status: ctx.pipeline.status },
      messages: result.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pipelines/:id/approval-chat
// Body: { message: string }
// Appends the user message, runs an LLM turn with the stage doc as context,
// stores the assistant reply, and returns both messages.
router.post('/:id/approval-chat', async (req, res) => {
  const { message } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  try {
    const ctx = await loadPipelineForApproval(req.params.id);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });
    const subjectId = `${ctx.pipeline.id}:${ctx.stage.stage}`;

    const userId = randomUUID();
    await query(
      `INSERT INTO decision_chats (id, subject_type, subject_id, role, content, created_at)
       VALUES ($1, 'pipeline_stage', $2, 'user', $3, NOW())`,
      [userId, subjectId, String(message).trim()]
    );

    const history = await query(
      `SELECT role, content FROM decision_chats
       WHERE subject_type = 'pipeline_stage' AND subject_id = $1
       ORDER BY created_at ASC`,
      [subjectId]
    );

    const docs = await loadProjectDocs(ctx.projectRoot);
    const { buildPipelineStagePrompt, sendChatTurn } = await getDecisionChat();
    const systemPrompt = buildPipelineStagePrompt({
      pipeline: ctx.pipeline,
      stage: ctx.stage,
      stageOutput: ctx.stageOutput,
      docs,
    });
    const reply = await sendChatTurn({ systemPrompt, messages: history.rows });

    const assistantId = randomUUID();
    await query(
      `INSERT INTO decision_chats (id, subject_type, subject_id, role, content, created_at)
       VALUES ($1, 'pipeline_stage', $2, 'assistant', $3, NOW())`,
      [assistantId, subjectId, reply]
    );

    res.json({
      user: { id: userId, role: 'user', content: String(message).trim() },
      assistant: { id: assistantId, role: 'assistant', content: reply },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pipelines/:id/send-back
// Body: { feedback?: string }
// If feedback is provided, use it directly. Otherwise, summarize the chat
// history into a feedback string. Persists the feedback on the rejected
// stage output, then calls the existing reject-and-rerun flow.
router.post('/:id/send-back', async (req, res) => {
  try {
    const ctx = await loadPipelineForApproval(req.params.id);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    let feedback = req.body && req.body.feedback ? String(req.body.feedback).trim() : '';

    if (!feedback) {
      const subjectId = `${ctx.pipeline.id}:${ctx.stage.stage}`;
      const history = await query(
        `SELECT role, content FROM decision_chats
         WHERE subject_type = 'pipeline_stage' AND subject_id = $1
         ORDER BY created_at ASC`,
        [subjectId]
      );
      if (history.rows.length === 0) {
        return res.status(400).json({ error: 'feedback is required (or chat with the thinking partner first)' });
      }
      const docs = await loadProjectDocs(ctx.projectRoot);
      const { buildPipelineStagePrompt, draftStageFeedback } = await getDecisionChat();
      const systemPrompt = buildPipelineStagePrompt({
        pipeline: ctx.pipeline,
        stage: ctx.stage,
        stageOutput: ctx.stageOutput,
        docs,
      });
      const drafted = await draftStageFeedback({ systemPrompt, messages: history.rows });
      feedback = (drafted.feedback || '').trim();
      if (!feedback) {
        return res.status(500).json({ error: 'Failed to summarize feedback from chat' });
      }
    }

    // Persist the feedback on the latest stage output for audit trail.
    await query(
      `UPDATE pipeline_stage_outputs
         SET rejection_feedback = $1
         WHERE id = (
           SELECT id FROM pipeline_stage_outputs
           WHERE pipeline_id = $2 AND stage = $3
           ORDER BY iteration DESC LIMIT 1
         )`,
      [feedback, ctx.pipeline.id, ctx.stage.stage]
    );

    await runtime.rejectAndBroadcast(ctx.pipeline.id, feedback);
    res.json({ ok: true, feedback });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
