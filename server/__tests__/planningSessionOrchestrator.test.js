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

describe('ensureRateLimit', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('passes when count is below the limit', async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [{ count: '3' }], rowCount: 1 }));
    await expect(orchestrator.ensureRateLimit('proj-A')).resolves.toBeUndefined();
  });

  it('throws RATE_LIMITED when count is at the limit', async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [{ count: String(orchestrator.RATE_LIMIT_PER_HOUR) }], rowCount: 1 }));
    let err;
    try { await orchestrator.ensureRateLimit('proj-A'); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('RATE_LIMITED');
  });

  it('throws RATE_LIMITED when count exceeds limit', async () => {
    mockQuery.mockImplementationOnce(async () => ({ rows: [{ count: '999' }], rowCount: 1 }));
    let err;
    try { await orchestrator.ensureRateLimit('proj-A'); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('RATE_LIMITED');
  });
});

describe('defaultTimeoutSeconds', () => {
  it('returns 180 for planning', () => {
    expect(orchestrator.defaultTimeoutSeconds('planning')).toBe(180);
  });
  it('returns 300 for extraction', () => {
    expect(orchestrator.defaultTimeoutSeconds('extraction')).toBe(300);
  });
  it('returns 0 (no timeout) for implementation', () => {
    expect(orchestrator.defaultTimeoutSeconds('implementation')).toBe(0);
  });
  it('falls back to planning timeout for unknown types', () => {
    expect(orchestrator.defaultTimeoutSeconds('unknown')).toBe(180);
  });
});
