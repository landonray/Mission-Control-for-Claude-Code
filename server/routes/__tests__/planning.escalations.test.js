import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { initializeDb, query } from '../../database.js';
import planningRouter from '../planning.js';

const TEST_PROJECT_A = 'test-decisions-proj-a';
const TEST_PROJECT_B = 'test-decisions-proj-b';
const TEST_SESSION = 'test-decisions-session';

describe('GET /api/planning/escalations cross-project', () => {
  let app;

  beforeAll(async () => {
    await initializeDb();
    app = express();
    app.use(express.json());
    app.use('/api/planning', planningRouter);

    await query(`INSERT INTO projects (id, name, root_path, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (id) DO NOTHING`, [TEST_PROJECT_A, 'A', '/tmp/test-proj-a']);
    await query(`INSERT INTO projects (id, name, root_path, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (id) DO NOTHING`, [TEST_PROJECT_B, 'B', '/tmp/test-proj-b']);
    await query(`INSERT INTO sessions (id, name, project_id, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (id) DO NOTHING`, [TEST_SESSION, 'test-session-a', TEST_PROJECT_A]);
    await query(`DELETE FROM planning_questions WHERE id LIKE 'test-decisions-q-%'`);
    await query(
      `INSERT INTO planning_questions (id, project_id, planning_session_id, question, status, asked_at)
       VALUES ('test-decisions-q-1', $1, $2, 'Q1', 'escalated', NOW()),
              ('test-decisions-q-2', $1, $2, 'Q2', 'escalated', NOW())`,
      [TEST_PROJECT_A, TEST_SESSION]
    );
    await query(
      `INSERT INTO sessions (id, name, project_id, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (id) DO NOTHING`,
      ['test-decisions-session-b', 'test-session-b', TEST_PROJECT_B]
    );
    await query(
      `INSERT INTO planning_questions (id, project_id, planning_session_id, question, status, asked_at)
       VALUES ('test-decisions-q-3', $1, $2, 'Q3', 'escalated', NOW())`,
      [TEST_PROJECT_B, 'test-decisions-session-b']
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM planning_questions WHERE id LIKE 'test-decisions-q-%'`);
  });

  it('returns escalations for a single project when project_id given', async () => {
    const res = await request(app).get(`/api/planning/escalations?project_id=${TEST_PROJECT_A}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((r) => r.id).sort();
    expect(ids).toEqual(['test-decisions-q-1', 'test-decisions-q-2']);
  });

  it('returns escalations across all projects when project_id omitted', async () => {
    const res = await request(app).get('/api/planning/escalations');
    expect(res.status).toBe(200);
    const ids = res.body.filter((r) => r.id.startsWith('test-decisions-q-')).map((r) => r.id).sort();
    expect(ids).toEqual(['test-decisions-q-1', 'test-decisions-q-2', 'test-decisions-q-3']);
  });

  it('includes project_name in cross-project response', async () => {
    const res = await request(app).get('/api/planning/escalations');
    const q3 = res.body.find((r) => r.id === 'test-decisions-q-3');
    expect(q3.project_name).toBe('B');
  });
});
