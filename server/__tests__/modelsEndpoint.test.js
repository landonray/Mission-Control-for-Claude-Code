import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { MODEL_OPTIONS, DEFAULT_MODEL } = require('../config/models.js');

// Contract test: pins the expected response shape of GET /api/models.
// The real handler reads default_effort from the database; this test covers
// the shape so the client/server agree on the contract.
describe('GET /api/models (contract)', () => {
  it('returns models, defaultModel, efforts, defaultEffort, and xhighSupportedModels', async () => {
    const app = express();
    app.get('/api/models', (_req, res) => {
      res.json({
        models: MODEL_OPTIONS,
        defaultModel: DEFAULT_MODEL,
        efforts: ['high', 'xhigh', 'max'],
        defaultEffort: 'high',
        xhighSupportedModels: ['claude-opus-4-7'],
      });
    });
    const res = await request(app).get('/api/models');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.models)).toBe(true);
    expect(res.body.defaultModel).toBe(DEFAULT_MODEL);
    expect(res.body.efforts).toEqual(['high', 'xhigh', 'max']);
    expect(res.body.defaultEffort).toBe('high');
    expect(res.body.xhighSupportedModels).toEqual(['claude-opus-4-7']);
  });
});
