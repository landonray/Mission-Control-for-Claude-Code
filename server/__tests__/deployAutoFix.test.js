import { describe, it, expect, vi } from 'vitest';
import { buildFixPrompt, ensureFixSession, TRIGGER_STATUSES } from '../services/deployAutoFix.js';

function makeFakeQuery(rowsByCall) {
  const queue = [...rowsByCall];
  const fn = vi.fn(async () => {
    const rows = queue.shift() || [];
    return { rows, rowCount: rows.length };
  });
  return fn;
}

function makeFakeQueryAdvanced(responses) {
  const queue = [...responses];
  const fn = vi.fn(async () => {
    const next = queue.shift();
    if (!next) return { rows: [], rowCount: 0 };
    if (Array.isArray(next)) return { rows: next, rowCount: next.length };
    return next;
  });
  return fn;
}

describe('TRIGGER_STATUSES', () => {
  it('includes the Railway failure states', () => {
    expect(TRIGGER_STATUSES.has('FAILED')).toBe(true);
    expect(TRIGGER_STATUSES.has('CRASHED')).toBe(true);
  });

  it('does not include non-failure states', () => {
    for (const s of ['SUCCESS', 'BUILDING', 'DEPLOYING', 'REMOVED', 'SKIPPED']) {
      expect(TRIGGER_STATUSES.has(s)).toBe(false);
    }
  });
});

describe('buildFixPrompt', () => {
  it('includes the project name, status, and log tail', () => {
    const prompt = buildFixPrompt({
      projectName: 'acme',
      deployStatus: 'FAILED',
      logs: 'line 1\nline 2\nnpm ERR!',
    });
    expect(prompt).toContain('acme');
    expect(prompt).toContain('FAILED');
    expect(prompt).toContain('npm ERR!');
    expect(prompt).toMatch(/Please:/);
    expect(prompt).toMatch(/commit and push/i);
  });

  it('handles missing logs gracefully', () => {
    const prompt = buildFixPrompt({
      projectName: 'acme',
      deployStatus: 'CRASHED',
      logs: null,
    });
    expect(prompt).toContain('(no log captured)');
  });

  it('truncates very long logs to the tail', () => {
    const longLog = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const prompt = buildFixPrompt({
      projectName: 'acme',
      deployStatus: 'FAILED',
      logs: longLog,
    });
    expect(prompt).toContain('line 499');
    expect(prompt).not.toContain('line 0\n');
  });
});

describe('ensureFixSession', () => {
  const baseRow = {
    id: 'p-1',
    name: 'acme',
    root_path: '/tmp/acme',
    last_deploy_status: 'FAILED',
    last_deploy_logs: 'build exploded',
    fix_session_id: null,
  };

  it('returns null when the project is missing', async () => {
    const query = makeFakeQuery([[]]);
    const result = await ensureFixSession('nope', { query, createSession: vi.fn() });
    expect(result).toBeNull();
  });

  it('does nothing if the deploy is not in a failure state', async () => {
    const query = makeFakeQuery([[{ ...baseRow, last_deploy_status: 'SUCCESS' }]]);
    const createSession = vi.fn();
    const result = await ensureFixSession('p-1', { query, createSession });
    expect(result).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('returns the existing fix session without creating a new one', async () => {
    const query = makeFakeQuery([[{ ...baseRow, fix_session_id: 'existing' }]]);
    const createSession = vi.fn();
    const result = await ensureFixSession('p-1', { query, createSession });
    expect(result).toBe('existing');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('creates a new session and stores its id on the project', async () => {
    const query = makeFakeQueryAdvanced([
      [baseRow],
      { rows: [], rowCount: 1 },
    ]);
    const createSession = vi.fn(async (opts) => {
      expect(opts.name).toMatch(/Fix Railway build for acme/);
      expect(opts.workingDirectory).toBe('/tmp/acme');
      expect(opts.useWorktree).toBe(true);
      expect(opts.initialPrompt).toContain('build exploded');
      return { id: 'sess-1', name: opts.name, status: 'idle' };
    });
    const result = await ensureFixSession('p-1', { query, createSession });
    expect(result).toBe('sess-1');
    expect(createSession).toHaveBeenCalledOnce();
  });

  it('defers to the winning fix session if another caller races in', async () => {
    const query = makeFakeQueryAdvanced([
      [baseRow],
      { rows: [], rowCount: 0 },
      [{ fix_session_id: 'winner' }],
    ]);
    const createSession = vi.fn(async () => ({ id: 'loser', name: 'x', status: 'idle' }));
    const result = await ensureFixSession('p-1', { query, createSession });
    expect(result).toBe('winner');
  });

  it('triggers on CRASHED status as well', async () => {
    const query = makeFakeQueryAdvanced([
      [{ ...baseRow, last_deploy_status: 'CRASHED' }],
      { rows: [], rowCount: 1 },
    ]);
    const createSession = vi.fn(async () => ({ id: 'sess-2', name: 'x', status: 'idle' }));
    const result = await ensureFixSession('p-1', { query, createSession });
    expect(result).toBe('sess-2');
    expect(createSession).toHaveBeenCalledOnce();
  });
});
