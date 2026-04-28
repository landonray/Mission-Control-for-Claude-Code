import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://stub:stub@stub.invalid/stub';

const trigger = await import('../contextDocAutoTrigger.js');

function buildDb({ sessionToProject = {}, projects = [] } = {}) {
  return vi.fn(async (sql, params = []) => {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    if (trimmed.startsWith('SELECT project_id FROM sessions')) {
      const sessionId = params[0];
      const projectId = sessionToProject[sessionId] ?? null;
      return { rows: projectId ? [{ project_id: projectId }] : [] };
    }
    if (trimmed.startsWith('SELECT id, name FROM projects')) {
      return { rows: projects };
    }
    throw new Error(`Unhandled SQL in fake db: ${trimmed.slice(0, 80)}`);
  });
}

describe('contextDocAutoTrigger.isMergeCommand', () => {
  const matches = [
    'gh pr merge 123',
    'gh pr merge 123 --squash --delete-branch',
    'cd /repo && gh pr merge --auto',
    'git merge feature-branch',
    'git merge --no-ff origin/main',
    'cd repo && git merge release',
  ];
  for (const cmd of matches) {
    it(`detects merge in: ${cmd}`, () => {
      expect(trigger.isMergeCommand(cmd)).toBe(true);
    });
  }

  const nonMatches = [
    'git push origin main',
    'gh pr create --title x',
    'git merge-base main HEAD',
    'git merge-tree --write-tree main feature',
    'gh pr merge --help',
    'git status',
    '',
  ];
  for (const cmd of nonMatches) {
    it(`does NOT match: "${cmd}"`, () => {
      expect(trigger.isMergeCommand(cmd)).toBe(false);
    });
  }
});

describe('contextDocAutoTrigger.onBashCommand', () => {
  let startGeneration;
  let getActiveRun;

  beforeEach(() => {
    vi.useFakeTimers();
    startGeneration = vi.fn().mockResolvedValue('run-123');
    getActiveRun = vi.fn().mockResolvedValue(null);
    trigger._setForTests({
      query: buildDb({ sessionToProject: { 'sess-1': 'proj-A' } }),
      startGeneration,
      getActiveRun,
    });
  });

  afterEach(() => {
    trigger._resetForTests();
    vi.useRealTimers();
  });

  it('does nothing for non-merge bash commands', async () => {
    await trigger.onBashCommand('sess-1', 'git status');
    await vi.advanceTimersByTimeAsync(trigger.DEBOUNCE_MS + 100);
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('schedules and fires regen after the debounce window for a merge command', async () => {
    await trigger.onBashCommand('sess-1', 'gh pr merge 42 --squash');
    expect(startGeneration).not.toHaveBeenCalled(); // not yet — still debouncing
    await vi.advanceTimersByTimeAsync(trigger.DEBOUNCE_MS + 100);
    expect(startGeneration).toHaveBeenCalledTimes(1);
    expect(startGeneration).toHaveBeenCalledWith('proj-A');
  });

  it('coalesces multiple merges within the debounce window into one regen', async () => {
    await trigger.onBashCommand('sess-1', 'gh pr merge 1');
    await vi.advanceTimersByTimeAsync(10_000);
    await trigger.onBashCommand('sess-1', 'gh pr merge 2');
    await vi.advanceTimersByTimeAsync(10_000);
    await trigger.onBashCommand('sess-1', 'git merge release');
    await vi.advanceTimersByTimeAsync(trigger.DEBOUNCE_MS + 100);
    // All three merges collapse into a single regen.
    expect(startGeneration).toHaveBeenCalledTimes(1);
  });

  it('skips when an existing run is already in progress', async () => {
    getActiveRun.mockResolvedValue({ id: 'existing-run-id' });
    await trigger.onBashCommand('sess-1', 'gh pr merge 1');
    await vi.advanceTimersByTimeAsync(trigger.DEBOUNCE_MS + 100);
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('skips when the session has no linked project', async () => {
    trigger._setForTests({
      query: buildDb({ sessionToProject: { 'sess-1': null } }),
      startGeneration,
      getActiveRun,
    });
    await trigger.onBashCommand('sess-1', 'gh pr merge 1');
    await vi.advanceTimersByTimeAsync(trigger.DEBOUNCE_MS + 100);
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('swallows orchestrator errors so one bad project does not break future triggers', async () => {
    const err = new Error('boom');
    err.code = 'NO_GITHUB_REPO';
    startGeneration.mockRejectedValueOnce(err);
    await trigger.onBashCommand('sess-1', 'gh pr merge 1');
    await vi.advanceTimersByTimeAsync(trigger.DEBOUNCE_MS + 100);
    // Did not throw; second merge attempt still works
    startGeneration.mockResolvedValue('run-456');
    await trigger.onBashCommand('sess-1', 'gh pr merge 2');
    await vi.advanceTimersByTimeAsync(trigger.DEBOUNCE_MS + 100);
    expect(startGeneration).toHaveBeenCalledTimes(2);
  });
});

describe('contextDocAutoTrigger.runNightlySweep', () => {
  let startGeneration;
  let getActiveRun;

  beforeEach(() => {
    startGeneration = vi.fn().mockResolvedValue('run-x');
    getActiveRun = vi.fn().mockResolvedValue(null);
  });

  afterEach(() => {
    trigger._resetForTests();
  });

  it('fires regen for every project with a github_repo', async () => {
    trigger._setForTests({
      query: buildDb({ projects: [
        { id: 'p1', name: 'Project One' },
        { id: 'p2', name: 'Project Two' },
        { id: 'p3', name: 'Project Three' },
      ] }),
      startGeneration,
      getActiveRun,
    });

    const result = await trigger.runNightlySweep();

    expect(result).toEqual({ triggered: 3, skipped: 0, failed: 0 });
    expect(startGeneration.mock.calls.map(c => c[0])).toEqual(['p1', 'p2', 'p3']);
  });

  it('skips projects with an active run instead of throwing', async () => {
    trigger._setForTests({
      query: buildDb({ projects: [
        { id: 'busy', name: 'Busy Project' },
        { id: 'idle', name: 'Idle Project' },
      ] }),
      startGeneration,
      getActiveRun: vi.fn(async (id) => id === 'busy' ? { id: 'existing' } : null),
    });

    const result = await trigger.runNightlySweep();
    expect(result.triggered).toBe(1);
    expect(result.skipped).toBe(1);
    expect(startGeneration.mock.calls.map(c => c[0])).toEqual(['idle']);
  });

  it('counts failures and continues with the rest of the projects', async () => {
    startGeneration
      .mockResolvedValueOnce('ok-1')
      .mockRejectedValueOnce(new Error('something went wrong'))
      .mockResolvedValueOnce('ok-3');
    trigger._setForTests({
      query: buildDb({ projects: [
        { id: 'p1', name: 'one' },
        { id: 'p2', name: 'two' },
        { id: 'p3', name: 'three' },
      ] }),
      startGeneration,
      getActiveRun,
    });

    const result = await trigger.runNightlySweep();
    expect(result).toEqual({ triggered: 2, skipped: 1, failed: 0 });
    expect(startGeneration).toHaveBeenCalledTimes(3);
  });

  it('returns a zero-counts result and does not throw if the project query fails', async () => {
    trigger._setForTests({
      query: vi.fn().mockRejectedValue(new Error('db down')),
      startGeneration,
      getActiveRun,
    });
    const result = await trigger.runNightlySweep();
    expect(result).toEqual({ triggered: 0, skipped: 0, failed: 0 });
    expect(startGeneration).not.toHaveBeenCalled();
  });
});
