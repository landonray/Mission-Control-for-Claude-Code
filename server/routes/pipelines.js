const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const repo = require('../services/pipelineRepo');
const runtime = require('../services/pipelineRuntime');
const { query } = require('../database');

router.post('/', async (req, res) => {
  try {
    const { project_id, name, spec_input } = req.body || {};
    if (!project_id || !name || !spec_input) {
      return res.status(400).json({ error: 'project_id, name, and spec_input are required' });
    }
    const orchestrator = runtime.getOrchestrator();
    const pipeline = await orchestrator.createAndStart({
      projectId: project_id,
      name,
      specInput: spec_input,
    });
    res.status(201).json(pipeline);
  } catch (err) {
    console.error('POST /api/pipelines failed:', err);
    if (/already has an active pipeline/i.test(err.message)) {
      return res.status(409).json({ error: err.message });
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
    const sessions = await query(
      `SELECT id, status, session_type, created_at, ended_at, pipeline_stage
       FROM sessions WHERE pipeline_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ pipeline, outputs, prompts, sessions: sessions.rows });
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
    if (![1, 2, 3].includes(stage)) return res.status(400).json({ error: 'Stage must be 1, 2, or 3' });
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
    const fullPath = path.join(projectRow.rows[0].root_path, output.output_path);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Output file missing on disk' });
    const content = fs.readFileSync(fullPath, 'utf8');
    res.json({ content, output_path: output.output_path, status: output.status, iteration: output.iteration });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
