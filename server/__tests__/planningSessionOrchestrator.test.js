/**
 * Unit tests for the planning session orchestrator.
 *
 * Covers the pure logic that doesn't require a real Claude CLI: the planning
 * prompt builder, context-file loader, and the rate-limit guard.
 *
 * The end-to-end startPlanningSession + sendAndAwait flow is exercised at the
 * integration level (manual smoke test against the running server) since it
 * spawns Claude CLI processes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

process.env.DATABASE_URL = 'postgresql://test:test@host.test/db';

const require = createRequire(import.meta.url);

const mockQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));

// Cache-poison the database module so the orchestrator's CJS require picks
// up our mock instead of touching Neon.
const databasePath = path.resolve(__dirname, '..', 'database.js');
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { query: mockQuery },
};

// sessionManager is also CJS and pulls in lots of side effects. Stub it.
const sessionManagerPath = path.resolve(__dirname, '..', 'services', 'sessionManager.js');
require.cache[sessionManagerPath] = {
  id: sessionManagerPath,
  filename: sessionManagerPath,
  loaded: true,
  exports: {
    createSession: vi.fn(async () => ({ id: 'new-session-id', name: 'Planning', status: 'idle', sessionType: 'planning' })),
    getSession: vi.fn(),
    activeSessions: new Map(),
  },
};

const orchestrator = require('../services/planningSessionOrchestrator');

describe('buildPlanningPrompt', () => {
  it('includes the question + context sections', () => {
    const prompt = orchestrator.buildPlanningPrompt({
      task: 'Cursor or offset pagination?',
      contextSections: ['### PRODUCT.md\n\nWe are a B2B billing app.', '### ARCHITECTURE.md\n\nPostgres + Express.'],
    });
    expect(prompt).toContain('Cursor or offset pagination?');
    expect(prompt).toContain('PRODUCT.md');
    expect(prompt).toContain('ARCHITECTURE.md');
    expect(prompt).toContain('B2B billing app');
    expect(prompt).toContain('read-only planning mode');
  });

  it('uses a default system prompt when none is supplied', () => {
    const prompt = orchestrator.buildPlanningPrompt({ task: 'q', contextSections: [] });
    expect(prompt).toMatch(/senior product and architecture planning agent/);
  });

  it('uses a custom system prompt when supplied', () => {
    const prompt = orchestrator.buildPlanningPrompt({
      systemPrompt: 'You are a database expert.',
      task: 'q',
      contextSections: [],
    });
    expect(prompt).toContain('You are a database expert.');
    expect(prompt).not.toMatch(/senior product and architecture planning agent/);
  });
});

describe('loadProjectContextFiles', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
  });

  it('returns empty array when neither file exists', async () => {
    const sections = await orchestrator.loadProjectContextFiles(tmpDir);
    expect(sections).toEqual([]);
  });

  it('loads PRODUCT.md when present', async () => {
    fs.writeFileSync(path.join(tmpDir, 'PRODUCT.md'), '# Product\nA thing.');
    const sections = await orchestrator.loadProjectContextFiles(tmpDir);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain('### PRODUCT.md');
    expect(sections[0]).toContain('A thing.');
  });

  it('loads both PRODUCT.md and ARCHITECTURE.md when both present', async () => {
    fs.writeFileSync(path.join(tmpDir, 'PRODUCT.md'), 'P content');
    fs.writeFileSync(path.join(tmpDir, 'ARCHITECTURE.md'), 'A content');
    const sections = await orchestrator.loadProjectContextFiles(tmpDir);
    expect(sections).toHaveLength(2);
  });
});

describe('loadExtraContextFiles', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
  });

  it('refuses to load files outside the project root', async () => {
    fs.writeFileSync(path.join(tmpDir, 'safe.md'), 'safe');
    // Path traversal attempt — should be silently dropped
    const sections = await orchestrator.loadExtraContextFiles(tmpDir, ['../../../etc/passwd', 'safe.md']);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain('safe');
    expect(JSON.stringify(sections)).not.toContain('passwd');
  });

  it('returns empty when no context files supplied', async () => {
    const sections = await orchestrator.loadExtraContextFiles(tmpDir, []);
    expect(sections).toEqual([]);
  });
});

describe('no rate limit', () => {
  it('does not export the legacy rate-limit helpers anymore', () => {
    expect(orchestrator.ensureRateLimit).toBeUndefined();
    expect(orchestrator.RATE_LIMIT_PER_HOUR).toBeUndefined();
  });
});

describe('no default timeouts', () => {
  it('does not export the legacy default-timeout helpers anymore', () => {
    expect(orchestrator.defaultTimeoutSeconds).toBeUndefined();
    expect(orchestrator.DEFAULT_TIMEOUTS_SECONDS).toBeUndefined();
  });
});

describe('getStatus with planning-question overrides', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns waiting_for_owner when an open escalation exists', async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'sess-1', status: 'idle', session_type: 'planning', created_at: '2026-04-25T00:00:00Z', ended_at: null }],
    }));
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'pq-1', status: 'escalated', owner_answer: null, decided_by: null }],
    }));

    const result = await orchestrator.getStatus('sess-1');
    expect(result.status).toBe('waiting_for_owner');
    expect(result.lastResponse).toBeNull();
  });

  it('returns completed with the owner answer once recorded', async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'sess-1', status: 'idle', session_type: 'planning', created_at: '2026-04-25T00:00:00Z', ended_at: null }],
    }));
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'pq-1', status: 'answered', owner_answer: 'Owner says yes.', decided_by: 'owner' }],
    }));

    const result = await orchestrator.getStatus('sess-1');
    expect(result.status).toBe('completed');
    expect(result.lastResponse).toBe('Owner says yes.');
  });

  it('falls through to last assistant text for planning-agent answers', async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'sess-1', status: 'idle', session_type: 'planning', created_at: '2026-04-25T00:00:00Z', ended_at: null }],
    }));
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'pq-1', status: 'answered', owner_answer: null, decided_by: 'planning-agent' }],
    }));
    mockQuery.mockImplementationOnce(async () => ({ rows: [{ content: 'Agent answer text.' }] }));

    const result = await orchestrator.getStatus('sess-1');
    expect(result.status).toBe('completed');
    expect(result.lastResponse).toBe('Agent answer text.');
  });

  it('returns dismissed when the escalation was dismissed by the owner', async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'sess-1', status: 'idle', session_type: 'planning', created_at: '2026-04-25T00:00:00Z', ended_at: null }],
    }));
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{ id: 'pq-1', status: 'dismissed', owner_answer: null, decided_by: null }],
    }));

    const result = await orchestrator.getStatus('sess-1');
    expect(result.status).toBe('dismissed');
    expect(result.lastResponse).toMatch(/dismissed/i);
  });
});
