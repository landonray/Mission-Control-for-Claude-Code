import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import { createRequire } from 'module';

// Load .env (server/routes/__tests__ → 6 levels up to main repo).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let envPath = path.resolve(__dirname, '../../../../../../.env');
if (!existsSync(envPath)) {
  envPath = path.resolve(__dirname, '../../../../../.env');
}
dotenv.config({ path: envPath, override: true });

const require = createRequire(import.meta.url);
const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

let query, initializeDb, repo, runtime, pipelinesRouter;

const TEST_PROJECT_ID = `test-routes-${crypto.randomBytes(4).toString('hex')}`;
const TEST_ROOT = mkdtempSync(path.join(os.tmpdir(), 'pipe-routes-'));

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/pipelines', pipelinesRouter);
  return app;
}

beforeAll(async () => {
  ({ query, initializeDb } = require('../../database'));
  repo = require('../../services/pipelineRepo');
  runtime = require('../../services/pipelineRuntime');
  pipelinesRouter = require('../pipelines');
  await initializeDb();
  await query(
    `INSERT INTO projects (id, name, root_path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [TEST_PROJECT_ID, 'routes test project', TEST_ROOT]
  );

  // Replace the live orchestrator with a test stub that captures calls but doesn't
  // spawn real sessions or git branches.
  runtime.start();
  const orchestrator = runtime.getOrchestrator();
  orchestrator.createAndStart = async ({ projectId, name, specInput }) => {
    const p = await repo.createPipeline({ projectId, name, specInput });
    await repo.updateStatus(p.id, { status: 'running', currentStage: 1 });
    return await repo.getPipeline(p.id);
  };
  orchestrator.approveCurrentStage = async () => undefined;
  orchestrator.rejectCurrentStage = async () => undefined;
});

beforeEach(async () => {
  await query('DELETE FROM pipelines WHERE project_id = $1', [TEST_PROJECT_ID]);
});

describe('pipelines routes', () => {
  it('POST /api/pipelines creates and starts a pipeline', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/pipelines').send({
      project_id: TEST_PROJECT_ID,
      name: 'Add foo',
      spec_input: 'Build foo.',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.status).toBe('running');
  });

  it('POST /api/pipelines returns 400 for missing fields', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/pipelines').send({ name: 'No project' });
    expect(res.status).toBe(400);
  });

  it('GET /api/pipelines?project_id=X lists pipelines for a project', async () => {
    await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'A', specInput: 's' });
    await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'B', specInput: 's' });
    const app = makeApp();
    const res = await request(app).get(`/api/pipelines?project_id=${TEST_PROJECT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.pipelines).toHaveLength(2);
  });

  it('GET /api/pipelines/:id returns pipeline detail with stage outputs and prompts', async () => {
    const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'X', specInput: 's' });
    await repo.recordStageOutput({ pipelineId: p.id, stage: 1, iteration: 1, outputPath: 'docs/specs/x-refined.md' });
    const app = makeApp();
    const res = await request(app).get(`/api/pipelines/${p.id}`);
    expect(res.status).toBe(200);
    expect(res.body.pipeline.id).toBe(p.id);
    expect(res.body.outputs).toHaveLength(1);
    expect(res.body.prompts).toHaveProperty('1');
  });

  it('POST /api/pipelines/:id/approve returns ok', async () => {
    const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'X', specInput: 's' });
    const app = makeApp();
    const res = await request(app).post(`/api/pipelines/${p.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/pipelines/:id/reject requires feedback', async () => {
    const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'X', specInput: 's' });
    const app = makeApp();
    const res = await request(app).post(`/api/pipelines/${p.id}/reject`).send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/pipelines/:id/reject with feedback returns ok', async () => {
    const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'X', specInput: 's' });
    const app = makeApp();
    const res = await request(app).post(`/api/pipelines/${p.id}/reject`).send({ feedback: 'too short' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('PUT /api/pipelines/:id/prompts/:stage updates a stage prompt', async () => {
    const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'X', specInput: 's' });
    const app = makeApp();
    const res = await request(app).put(`/api/pipelines/${p.id}/prompts/1`).send({ prompt: 'NEW PROMPT' });
    expect(res.status).toBe(200);
    const prompts = await repo.getStagePrompts(p.id);
    expect(prompts['1']).toBe('NEW PROMPT');
  });

  it('GET /api/pipelines/:id/output/:stage returns the latest stage output content', async () => {
    const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'X', specInput: 's' });
    const outputPath = path.join(TEST_ROOT, 'docs/specs/x-refined.md');
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, '# refined spec content');
    await repo.recordStageOutput({ pipelineId: p.id, stage: 1, iteration: 1, outputPath: 'docs/specs/x-refined.md' });
    const app = makeApp();
    const res = await request(app).get(`/api/pipelines/${p.id}/output/1`);
    expect(res.status).toBe(200);
    expect(res.body.content).toContain('refined spec content');
  });
});
