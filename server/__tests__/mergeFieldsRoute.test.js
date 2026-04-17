import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'module';

// Use CommonJS require so we share one module instance with the router
// (which also requires this service via CJS). Under Vitest, ESM `import`
// of a CJS module produces a separate instance with its own registry.
const require = createRequire(import.meta.url);
const mergeFieldsRouter = require('../routes/mergeFields');
const { registerField, _clearRegistryForTests } = require('../services/mergeFields');

const app = express();
app.use('/api/merge-fields', mergeFieldsRouter);

describe('GET /api/merge-fields', () => {
  beforeEach(() => {
    _clearRegistryForTests();
  });

  it('returns an empty array when no fields are registered', async () => {
    const res = await request(app).get('/api/merge-fields');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ fields: [] });
  });

  it('returns registered fields with name and description', async () => {
    registerField('last_pr', { description: 'most recently updated open PR number', resolve: async () => null });
    const res = await request(app).get('/api/merge-fields');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      fields: [{ name: 'last_pr', description: 'most recently updated open PR number' }],
    });
  });
});
