import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let envPath = path.resolve(__dirname, '../../../../../../.env');
if (!existsSync(envPath)) {
  envPath = path.resolve(__dirname, '../../../../../.env');
}
dotenv.config({ path: envPath, override: true });

vi.mock('../../services/llmGateway.js', () => ({
  default: { chatCompletion: vi.fn().mockResolvedValue('mocked thinking-partner reply') },
  chatCompletion: vi.fn().mockResolvedValue('mocked thinking-partner reply'),
}));

vi.mock('../../services/decisionChat.js', () => ({
  buildSystemPrompt: () => 'mock system prompt',
  buildPipelineStagePrompt: () => 'mock pipeline prompt',
  sendChatTurn: vi.fn().mockResolvedValue('mocked thinking-partner reply'),
  draftFinalAnswer: vi.fn().mockResolvedValue({ answer: 'mock', reasoning_summary: '' }),
  draftStageFeedback: vi.fn().mockResolvedValue({ feedback: 'mocked thinking-partner reply' }),
}));

const require = createRequire(import.meta.url);
const PROJ = `pipe-chat-${crypto.randomBytes(4).toString('hex')}`;
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'pipe-chat-'));

let query, repo, runtime, pipelinesRouter;
let rejectCalls = [];

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/pipelines', pipelinesRouter);
  return app;
}

beforeAll(async () => {
  // Use createRequire so the test and the router share the same CJS module
  // instances (otherwise runtime.start() wouldn't be visible to the router).
  ({ query } = require('../../database'));
  const dbModule = require('../../database');
  await dbModule.initializeDb();
  repo = require('../../services/pipelineRepo');
  runtime = require('../../services/pipelineRuntime');
  pipelinesRouter = require('../pipelines');

  await query(
    `INSERT INTO projects (id, name, root_path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [PROJ, 'pipe chat test', ROOT]
  );
  runtime.start();
  const orchestrator = runtime.getOrchestrator();
  orchestrator.approveCurrentStage = async () => undefined;
  orchestrator.rejectCurrentStage = async (id, feedback) => {
    rejectCalls.push({ id, feedback });
  };
});

afterAll(async () => {
  await query(
    `DELETE FROM decision_chats WHERE subject_type = 'pipeline_stage'
       AND subject_id LIKE $1`,
    [`pipe_%`]
  );
  await query(`DELETE FROM pipeline_stage_outputs WHERE pipeline_id IN (SELECT id FROM pipelines WHERE project_id = $1)`, [PROJ]);
  await query(`DELETE FROM pipelines WHERE project_id = $1`, [PROJ]);
  await query(`DELETE FROM projects WHERE id = $1`, [PROJ]);
});

async function createPausedPipeline() {
  const p = await repo.createPipeline({ projectId: PROJ, name: 'ChatPipe', specInput: 's' });
  const outputPath = 'docs/specs/chatpipe-refined.md';
  mkdirSync(path.dirname(path.join(ROOT, outputPath)), { recursive: true });
  writeFileSync(path.join(ROOT, outputPath), '# refined spec\nThe quick brown fox.');
  await repo.recordStageOutput({ pipelineId: p.id, stage: 1, iteration: 1, outputPath });
  await repo.updateStatus(p.id, { status: 'paused_for_approval', currentStage: 1 });
  return p;
}

describe('pipeline approval chat', () => {
  it('GET /api/pipelines/:id/approval-chat returns empty messages and stage info initially', async () => {
    const p = await createPausedPipeline();
    const app = makeApp();
    const res = await request(app).get(`/api/pipelines/${p.id}/approval-chat`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.stage.stage).toBe(1);
    expect(res.body.stage.name).toBe('Spec Refinement');
  });

  it('GET returns chat history seeded under subject_type=pipeline_stage', async () => {
    // Verify the retrieval path uses the polymorphic key. We seed messages
    // directly to avoid the LLM call (vi.mock can't intercept the dynamic
    // ESM import the router uses for decisionChat).
    const p = await createPausedPipeline();
    const subjectId = `${p.id}:1`;
    await query(
      `INSERT INTO decision_chats (id, subject_type, subject_id, role, content, created_at)
       VALUES ($1, 'pipeline_stage', $2, 'user', 'why split here?', NOW())`,
      [crypto.randomUUID(), subjectId]
    );
    await query(
      `INSERT INTO decision_chats (id, subject_type, subject_id, role, content, created_at)
       VALUES ($1, 'pipeline_stage', $2, 'assistant', 'because of X', NOW() + INTERVAL '1 second')`,
      [crypto.randomUUID(), subjectId]
    );
    const app = makeApp();
    const res = await request(app).get(`/api/pipelines/${p.id}/approval-chat`);
    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBe(2);
    expect(res.body.messages[0].role).toBe('user');
    expect(res.body.messages[1].role).toBe('assistant');
  });

  it('rejects approval-chat when pipeline is not paused_for_approval', async () => {
    const p = await repo.createPipeline({ projectId: PROJ, name: 'NotPausedPipe', specInput: 's' });
    await repo.updateStatus(p.id, { status: 'running', currentStage: 1 });
    const app = makeApp();
    const res = await request(app)
      .post(`/api/pipelines/${p.id}/approval-chat`)
      .send({ message: 'hi' });
    expect(res.status).toBe(409);
  });
});

describe('pipeline send-back-with-feedback', () => {
  it('POST /api/pipelines/:id/send-back with explicit feedback persists it and calls reject', async () => {
    rejectCalls = [];
    const p = await createPausedPipeline();
    const app = makeApp();
    const res = await request(app)
      .post(`/api/pipelines/${p.id}/send-back`)
      .send({ feedback: 'Tighten the scope to the smallest viable change.' });
    expect(res.status).toBe(200);
    expect(res.body.feedback).toBe('Tighten the scope to the smallest viable change.');
    expect(rejectCalls.length).toBeGreaterThan(0);
    expect(rejectCalls[rejectCalls.length - 1].feedback).toBe('Tighten the scope to the smallest viable change.');

    const out = await query(
      `SELECT rejection_feedback FROM pipeline_stage_outputs WHERE pipeline_id = $1 AND stage = 1`,
      [p.id]
    );
    expect(out.rows[0].rejection_feedback).toBe('Tighten the scope to the smallest viable change.');
  });

  it('POST send-back with no feedback and no chat returns 400', async () => {
    const p = await createPausedPipeline();
    const app = makeApp();
    const res = await request(app).post(`/api/pipelines/${p.id}/send-back`).send({});
    expect(res.status).toBe(400);
  });

  it('POST send-back rejects when pipeline is not paused_for_approval', async () => {
    const p = await repo.createPipeline({ projectId: PROJ, name: 'NotPausedSendBack', specInput: 's' });
    await repo.updateStatus(p.id, { status: 'running', currentStage: 1 });
    const app = makeApp();
    const res = await request(app).post(`/api/pipelines/${p.id}/send-back`).send({ feedback: 'x' });
    expect(res.status).toBe(409);
  });
});
