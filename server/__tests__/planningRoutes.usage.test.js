import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

process.env.DATABASE_URL = 'postgresql://test:test@host.test/db';

const require = createRequire(import.meta.url);

const queryMock = vi.fn();

const databasePath = path.resolve(__dirname, '..', 'database.js');
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { query: (...args) => queryMock(...args) },
};

const planningRouter = require('../routes/planning');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/planning', planningRouter);
  return app;
}

describe('GET /api/planning/usage', () => {
  beforeEach(() => { queryMock.mockReset(); });

  it('returns per-session-type counts and durations for a project', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { session_type: 'planning', session_count: '5', total_duration_seconds: '600', avg_duration_seconds: '120' },
        { session_type: 'extraction', session_count: '2', total_duration_seconds: '300', avg_duration_seconds: '150' },
      ],
    });

    const res = await request(buildApp())
      .get('/api/planning/usage?project_id=p1&window=7d');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      window: '7d',
      stats: [
        { session_type: 'planning', session_count: 5, total_duration_seconds: 600, avg_duration_seconds: 120 },
        { session_type: 'extraction', session_count: 2, total_duration_seconds: 300, avg_duration_seconds: 150 },
      ],
    });
  });

  it('returns 400 when project_id is missing', async () => {
    const res = await request(buildApp()).get('/api/planning/usage');
    expect(res.status).toBe(400);
  });

  it('defaults window to 7 days when not specified', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).get('/api/planning/usage?project_id=p1');
    expect(res.status).toBe(200);
    expect(res.body.window).toBe('7d');
  });

  it('uses the all-time window when requested', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await request(buildApp()).get('/api/planning/usage?project_id=p1&window=all');
    const sql = queryMock.mock.calls[0][0];
    expect(sql).not.toMatch(/INTERVAL/);
  });
});
