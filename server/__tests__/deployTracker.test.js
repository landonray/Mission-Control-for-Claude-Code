import { describe, it, expect, vi } from 'vitest';
import {
  MIN_POLL_INTERVAL_MS,
  readProjectDeployRow,
  recordDeployStart,
  refreshDeployStatus,
  shouldSkipPoll,
  isTerminal,
} from '../services/deployTracker.js';

function makeFakeQuery(rowsByCall) {
  const calls = [];
  const queue = [...rowsByCall];
  const fn = vi.fn(async (sql, params) => {
    calls.push({ sql, params });
    const rows = queue.shift() || [];
    return { rows, rowCount: rows.length };
  });
  return { fn, calls };
}

describe('isTerminal', () => {
  it.each(['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED', 'SKIPPED'])(
    'treats %s as terminal',
    (status) => expect(isTerminal(status)).toBe(true)
  );
  it.each(['BUILDING', 'DEPLOYING', 'INITIALIZING', null, undefined])(
    'treats %s as non-terminal',
    (status) => expect(isTerminal(status)).toBe(false)
  );
});

describe('shouldSkipPoll', () => {
  const nowMs = Date.UTC(2026, 3, 20, 10, 0, 0);

  it('polls when the project has never been checked', () => {
    expect(shouldSkipPoll({ last_deploy_checked_at: null }, nowMs)).toBe(false);
  });

  it('skips when status is terminal', () => {
    expect(shouldSkipPoll(
      { last_deploy_checked_at: new Date(nowMs).toISOString(), last_deploy_status: 'SUCCESS' },
      nowMs
    )).toBe(true);
  });

  it('skips when the last poll was within the cooldown window', () => {
    const recent = new Date(nowMs - 1000).toISOString();
    expect(shouldSkipPoll(
      { last_deploy_checked_at: recent, last_deploy_status: 'BUILDING' },
      nowMs
    )).toBe(true);
  });

  it('polls again once the cooldown has passed', () => {
    const stale = new Date(nowMs - MIN_POLL_INTERVAL_MS - 1000).toISOString();
    expect(shouldSkipPoll(
      { last_deploy_checked_at: stale, last_deploy_status: 'BUILDING' },
      nowMs
    )).toBe(false);
  });
});

describe('readProjectDeployRow', () => {
  it('maps a DB row to a clean status object', () => {
    const row = {
      id: 'p-1',
      railway_project_id: 'rp',
      railway_service_id: 'rs',
      railway_environment_id: 're',
      deployment_url: 'https://x',
      last_deploy_id: 'd-1',
      last_deploy_status: 'SUCCESS',
      last_deploy_logs: 'ok',
      last_deploy_started_at: 't1',
      last_deploy_checked_at: 't2',
      fix_session_id: 'sess-1',
    };
    expect(readProjectDeployRow(row)).toEqual({
      projectId: 'p-1',
      railwayProjectId: 'rp',
      railwayServiceId: 'rs',
      railwayEnvironmentId: 're',
      deploymentUrl: 'https://x',
      lastDeployId: 'd-1',
      lastDeployStatus: 'SUCCESS',
      lastDeployLogs: 'ok',
      lastDeployStartedAt: 't1',
      lastDeployCheckedAt: 't2',
      fixSessionId: 'sess-1',
    });
  });
});

describe('recordDeployStart', () => {
  it('writes all Railway IDs and resets deploy state', async () => {
    const { fn } = makeFakeQuery([[]]);
    await recordDeployStart(
      {
        projectId: 'p-1',
        railwayProjectId: 'rp',
        railwayServiceId: 'rs',
        railwayEnvironmentId: 're',
        repo: 'me/acme',
      },
      { query: fn }
    );
    expect(fn).toHaveBeenCalledOnce();
    const [sql, params] = [fn.mock.calls[0][0], fn.mock.calls[0][1]];
    expect(sql).toMatch(/UPDATE projects/);
    expect(sql).toMatch(/railway_project_id = \$1/);
    expect(sql).toMatch(/last_deploy_status = 'BUILDING'/);
    expect(sql).toMatch(/deployment_url = NULL/);
    expect(sql).toMatch(/fix_session_id = NULL/);
    expect(params[0]).toBe('rp');
    expect(params[1]).toBe('rs');
    expect(params[2]).toBe('re');
    expect(params[3]).toBe('me/acme');
    expect(params[5]).toBe('p-1');
  });
});

describe('refreshDeployStatus', () => {
  const projectRow = {
    id: 'p-1',
    railway_project_id: 'rp',
    railway_service_id: 'rs',
    railway_environment_id: 're',
    deployment_url: null,
    last_deploy_id: null,
    last_deploy_status: 'BUILDING',
    last_deploy_logs: null,
    last_deploy_started_at: '2026-04-20T00:00:00.000Z',
    last_deploy_checked_at: '2026-04-20T00:00:00.000Z',
  };

  it('returns null when the project does not exist', async () => {
    const { fn } = makeFakeQuery([[]]);
    const out = await refreshDeployStatus('missing', 'tok', {
      query: fn,
      getLatestDeployment: vi.fn(),
      getBuildLogs: vi.fn(),
      now: Date.now(),
    });
    expect(out).toBeNull();
  });

  it('returns stored row unchanged when the service has no Railway IDs yet', async () => {
    const row = { ...projectRow, railway_service_id: null };
    const { fn } = makeFakeQuery([[row]]);
    const getLatest = vi.fn();
    const out = await refreshDeployStatus('p-1', 'tok', {
      query: fn,
      getLatestDeployment: getLatest,
      getBuildLogs: vi.fn(),
      now: Date.now(),
    });
    expect(getLatest).not.toHaveBeenCalled();
    expect(out.railwayServiceId).toBeNull();
  });

  it('skips the Railway call inside the cooldown window and returns stored status', async () => {
    const nowMs = Date.UTC(2026, 3, 20, 10, 0, 0);
    const recentlyChecked = {
      ...projectRow,
      last_deploy_checked_at: new Date(nowMs - 500).toISOString(),
    };
    const { fn } = makeFakeQuery([[recentlyChecked]]);
    const getLatest = vi.fn();
    const out = await refreshDeployStatus('p-1', 'tok', {
      query: fn,
      getLatestDeployment: getLatest,
      getBuildLogs: vi.fn(),
      now: nowMs,
    });
    expect(getLatest).not.toHaveBeenCalled();
    expect(out.lastDeployStatus).toBe('BUILDING');
  });

  it('writes status, url, and logs when the build succeeds', async () => {
    const staleRow = {
      ...projectRow,
      last_deploy_checked_at: new Date(Date.now() - 60000).toISOString(),
    };
    const updatedRow = {
      ...staleRow,
      last_deploy_id: 'd-1',
      last_deploy_status: 'SUCCESS',
      last_deploy_logs: 'build ok',
      deployment_url: 'https://acme.up.railway.app',
    };
    const { fn } = makeFakeQuery([[staleRow], [], [updatedRow]]);
    const getLatest = vi.fn(async () => ({
      id: 'd-1',
      status: 'SUCCESS',
      staticUrl: 'acme.up.railway.app',
    }));
    const getLogs = vi.fn(async () => 'build ok');
    const out = await refreshDeployStatus('p-1', 'tok', {
      query: fn,
      getLatestDeployment: getLatest,
      getBuildLogs: getLogs,
      now: Date.now(),
    });
    expect(getLatest).toHaveBeenCalledWith('rs', 'tok');
    expect(getLogs).toHaveBeenCalled();
    expect(out.lastDeployStatus).toBe('SUCCESS');
    expect(out.deploymentUrl).toBe('https://acme.up.railway.app');
    expect(out.lastDeployLogs).toBe('build ok');
    const updateCall = fn.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE projects/);
    expect(updateCall[1][1]).toBe('SUCCESS');
  });

  it('writes status and logs when the build fails', async () => {
    const staleRow = {
      ...projectRow,
      last_deploy_checked_at: new Date(Date.now() - 60000).toISOString(),
    };
    const updatedRow = {
      ...staleRow,
      last_deploy_id: 'd-1',
      last_deploy_status: 'FAILED',
      last_deploy_logs: 'npm run build failed',
    };
    const { fn } = makeFakeQuery([[staleRow], [], [updatedRow]]);
    const getLatest = vi.fn(async () => ({ id: 'd-1', status: 'FAILED' }));
    const getLogs = vi.fn(async () => 'npm run build failed');
    const out = await refreshDeployStatus('p-1', 'tok', {
      query: fn,
      getLatestDeployment: getLatest,
      getBuildLogs: getLogs,
      now: Date.now(),
    });
    expect(out.lastDeployStatus).toBe('FAILED');
    expect(out.lastDeployLogs).toBe('npm run build failed');
    expect(out.deploymentUrl).toBeNull();
  });

  it('does not fetch logs when the deployment is still building', async () => {
    const staleRow = {
      ...projectRow,
      last_deploy_checked_at: new Date(Date.now() - 60000).toISOString(),
    };
    const updatedRow = { ...staleRow, last_deploy_id: 'd-1', last_deploy_status: 'DEPLOYING' };
    const { fn } = makeFakeQuery([[staleRow], [], [updatedRow]]);
    const getLatest = vi.fn(async () => ({ id: 'd-1', status: 'DEPLOYING' }));
    const getLogs = vi.fn();
    const out = await refreshDeployStatus('p-1', 'tok', {
      query: fn,
      getLatestDeployment: getLatest,
      getBuildLogs: getLogs,
      now: Date.now(),
    });
    expect(getLogs).not.toHaveBeenCalled();
    expect(out.lastDeployStatus).toBe('DEPLOYING');
  });

  it('still records terminal status when logs fetch fails', async () => {
    const staleRow = {
      ...projectRow,
      last_deploy_checked_at: new Date(Date.now() - 60000).toISOString(),
    };
    const updatedRow = {
      ...staleRow,
      last_deploy_id: 'd-1',
      last_deploy_status: 'FAILED',
      last_deploy_logs: '(Could not fetch logs: boom)',
    };
    const { fn } = makeFakeQuery([[staleRow], [], [updatedRow]]);
    const getLatest = vi.fn(async () => ({ id: 'd-1', status: 'FAILED' }));
    const getLogs = vi.fn(async () => { throw new Error('boom'); });
    const out = await refreshDeployStatus('p-1', 'tok', {
      query: fn,
      getLatestDeployment: getLatest,
      getBuildLogs: getLogs,
      now: Date.now(),
    });
    expect(out.lastDeployStatus).toBe('FAILED');
    expect(out.lastDeployLogs).toMatch(/Could not fetch logs/);
  });
});
