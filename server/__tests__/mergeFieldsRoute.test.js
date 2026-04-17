import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'module';

// This test imports BOTH a CJS router AND the CJS service it depends on.
// Under Vitest, reaching the same CJS service via two different paths (ESM
// import from the test + CJS require from inside the router) produces two
// distinct module instances with separate registry Maps — the test would
// register into one and the route would read from the other. Sibling tests
// that only import the service directly don't hit this because they only
// use one resolution path. Forcing CJS `require` here keeps both paths on
// the same instance.
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
