import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { createRequire } from 'module';

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

let query, initializeDb, repo, decisionsRouter;
const PROJ = `decisions-route-${crypto.randomBytes(4).toString('hex')}`;
const SESS = `decisions-route-sess-${crypto.randomBytes(4).toString('hex')}`;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/decisions', decisionsRouter);
  return app;
}

beforeAll(async () => {
  ({ query, initializeDb } = require('../../database'));
  repo = require('../../services/pipelineRepo');
  decisionsRouter = require('../decisions');
  await initializeDb();
  await query(
    `INSERT INTO projects (id, name, root_path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [PROJ, 'decisions test', '/tmp/decisions-test']
  );
  await query(
    `INSERT INTO sessions (id, name, project_id, created_at) VALUES ($1, 'planning sess', $2, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [SESS, PROJ]
  );
});

afterAll(async () => {
  await query(`DELETE FROM pipeline_stage_outputs WHERE pipeline_id IN (SELECT id FROM pipelines WHERE project_id = $1)`, [PROJ]);
  await query(`DELETE FROM pipelines WHERE project_id = $1`, [PROJ]);
  await query(`DELETE FROM planning_questions WHERE project_id = $1`, [PROJ]);
  await query(`DELETE FROM sessions WHERE id = $1`, [SESS]);
  await query(`DELETE FROM projects WHERE id = $1`, [PROJ]);
});

describe('GET /api/decisions/pending', () => {
  it('returns a normalized list combining planning escalations and paused pipelines', async () => {
    const qid = `q-${crypto.randomBytes(4).toString('hex')}`;
    await query(
      `INSERT INTO planning_questions
         (id, project_id, planning_session_id, question, status, asked_at, escalation_recommendation)
         VALUES ($1, $2, $3, 'pick a name', 'escalated', NOW() - INTERVAL '10 minutes', 'use foo')`,
      [qid, PROJ, SESS]
    );

    const p = await repo.createPipeline({ projectId: PROJ, name: 'PendingPipe', specInput: 's' });
    await repo.recordStageOutput({ pipelineId: p.id, stage: 1, iteration: 1, outputPath: 'docs/specs/pendingpipe-refined.md' });
    await repo.updateStatus(p.id, { status: 'paused_for_approval', currentStage: 1 });

    const app = makeApp();
    const res = await request(app).get(`/api/decisions/pending?project_id=${PROJ}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);

    const kinds = res.body.items.map((i) => i.kind).sort();
    expect(kinds).toEqual(['pipeline_stage', 'planning']);

    const planning = res.body.items.find((i) => i.kind === 'planning');
    expect(planning.planning.question).toBe('pick a name');
    expect(planning.id).toBe(`pq_${qid}`);

    const stage = res.body.items.find((i) => i.kind === 'pipeline_stage');
    expect(stage.pipeline_stage.pipeline_id).toBe(p.id);
    expect(stage.pipeline_stage.stage).toBe(1);
    expect(stage.pipeline_stage.stage_name).toBe('Spec Refinement');
  });

  it('count endpoint returns the totals', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/decisions/pending/count');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('count');
    expect(res.body).toHaveProperty('planning');
    expect(res.body).toHaveProperty('pipeline_stage');
  });
});
