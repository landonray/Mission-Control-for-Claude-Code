import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

process.env.DATABASE_URL = 'postgresql://test:test@host.test/db';

const require = createRequire(import.meta.url);

const queryMock = vi.fn();
const appendDecisionMock = vi.fn();
const appendCtxMock = vi.fn();

const databasePath = path.resolve(__dirname, '..', 'database.js');
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { query: (...args) => queryMock(...args) },
};

const decisionLogPath = path.resolve(__dirname, '..', 'services', 'decisionLog.js');
require.cache[decisionLogPath] = {
  id: decisionLogPath,
  filename: decisionLogPath,
  loaded: true,
  exports: {
    appendDecision: (...a) => appendDecisionMock(...a),
    resolveDecisionFilePath: (root) => `${root}/docs/decisions.md`,
    parseDecisions: () => [],
  },
};

const ctxPath = path.resolve(__dirname, '..', 'services', 'contextDocAppender.js');
require.cache[ctxPath] = {
  id: ctxPath,
  filename: ctxPath,
  loaded: true,
  exports: {
    appendOwnerDecisionToContextDoc: (...a) => appendCtxMock(...a),
  },
};

const planningRouter = require('../routes/planning');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/planning', planningRouter);
  return app;
}

describe('GET /api/planning/escalations', () => {
  beforeEach(() => {
    queryMock.mockReset();
    appendDecisionMock.mockReset();
    appendCtxMock.mockReset();
  });

  it('returns escalated questions for a project', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'pq-1', project_id: 'p1', planning_session_id: 'sess-1',
        asking_session_id: 'imp-1', question: 'Q?',
        escalation_recommendation: 'Rec.',
        escalation_reason: 'Strategic.',
        escalation_context: 'Ctx.',
        working_files: 'a.js,b.js', status: 'escalated', asked_at: '2026-04-25T00:00:00Z',
      }],
    });
    const res = await request(buildApp()).get('/api/planning/escalations?project_id=p1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('pq-1');
    expect(res.body[0].working_files).toEqual(['a.js', 'b.js']);
  });

  it('returns all escalations across projects when project_id is omitted', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'pq-2', project_id: 'p2', planning_session_id: 'sess-2',
        asking_session_id: null, question: 'Cross-project Q?',
        escalation_recommendation: null,
        escalation_reason: null,
        escalation_context: null,
        working_files: null, status: 'escalated', asked_at: '2026-04-25T00:00:00Z',
        project_name: 'Project Two',
      }],
    });
    const res = await request(buildApp()).get('/api/planning/escalations');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('pq-2');
    expect(res.body[0].project_name).toBe('Project Two');
  });
});

describe('POST /api/planning/escalations/:id/answer', () => {
  beforeEach(() => {
    queryMock.mockReset();
    appendDecisionMock.mockReset();
    appendCtxMock.mockReset();
  });

  it('records owner answer, logs decision, optionally appends to context doc', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'pq-1', project_id: 'p1', planning_session_id: 'sess-1',
        asking_session_id: 'imp-1', question: 'Q?',
        working_files: 'a.js', root_path: '/tmp/proj', project_name: 'Demo',
      }],
    });
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE logged_to_file

    appendDecisionMock.mockResolvedValueOnce({ path: '/tmp/proj/docs/decisions.md' });
    appendCtxMock.mockResolvedValueOnce({ path: '/tmp/proj/PRODUCT.md' });

    const res = await request(buildApp())
      .post('/api/planning/escalations/pq-1/answer')
      .send({ answer: 'Yes, do it.', addToContextDoc: 'PRODUCT.md' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('answered');
    expect(res.body.contextDocAppended).toBe('/tmp/proj/PRODUCT.md');
    expect(appendDecisionMock).toHaveBeenCalledWith(
      '/tmp/proj/docs/decisions.md',
      expect.objectContaining({ decidedBy: 'owner', answer: 'Yes, do it.' })
    );
    expect(appendCtxMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: '/tmp/proj', doc: 'PRODUCT.md' })
    );
  });

  it('skips context doc append when addToContextDoc is "neither"', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'pq-1', project_id: 'p1', planning_session_id: 'sess-1',
        question: 'Q?', root_path: '/tmp/proj', project_name: 'Demo',
      }],
    });
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    appendDecisionMock.mockResolvedValueOnce({ path: 'x' });

    const res = await request(buildApp())
      .post('/api/planning/escalations/pq-1/answer')
      .send({ answer: 'No.', addToContextDoc: 'neither' });

    expect(res.status).toBe(200);
    expect(appendCtxMock).not.toHaveBeenCalled();
  });

  it('returns 404 if escalation not found', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .post('/api/planning/escalations/missing/answer')
      .send({ answer: 'X' });
    expect(res.status).toBe(404);
  });

  it('returns 400 if answer is missing', async () => {
    const res = await request(buildApp())
      .post('/api/planning/escalations/pq-1/answer')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/planning/escalations/:id/dismiss', () => {
  beforeEach(() => { queryMock.mockReset(); });
  it('marks the escalation as dismissed', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(buildApp()).post('/api/planning/escalations/pq-1/dismiss');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('dismissed');
    const sql = queryMock.mock.calls[0][0];
    expect(sql).toMatch(/status = 'dismissed'/);
  });
});
