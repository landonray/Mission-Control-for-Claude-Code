import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SKIP_ENV_KEYS,
  collectEnvVars,
  deployProjectToRailway,
  getLatestDeployment,
  getBuildLogs,
  stripAnsi,
} from '../services/railway.js';

describe('collectEnvVars', () => {
  it('returns an empty object when .env is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rw-'));
    expect(collectEnvVars(dir)).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns parsed variables and excludes skipped keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rw-'));
    fs.writeFileSync(
      path.join(dir, '.env'),
      [
        'PORT=4001',
        'VITE_PORT=5173',
        'NODE_ENV=development',
        'DATABASE_URL=postgres://foo/bar',
        'GOOGLE_CLIENT_ID=xyz',
      ].join('\n')
    );
    const vars = collectEnvVars(dir);
    expect(vars).toEqual({
      DATABASE_URL: 'postgres://foo/bar',
      GOOGLE_CLIENT_ID: 'xyz',
    });
    for (const skipped of SKIP_ENV_KEYS) {
      expect(vars[skipped]).toBeUndefined();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('deployProjectToRailway', () => {
  function makeRequestFn(responses) {
    const calls = [];
    const fn = vi.fn(async (query, variables) => {
      calls.push({ query, variables });
      const match = responses.find(r => query.includes(r.name));
      if (!match) throw new Error(`No mock response for query: ${query}`);
      if (match.error) throw new Error(match.error);
      return match.data;
    });
    return { fn, calls };
  }

  it('throws when no GitHub repo can be resolved', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rw-'));
    await expect(
      deployProjectToRailway(
        { projectName: 'acme', projectPath: dir, githubRepo: null, token: 'tok' },
        { requestFn: vi.fn() }
      )
    ).rejects.toThrow(/GitHub remote/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('calls Railway API in the right sequence and returns deployment info', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rw-'));
    fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgres://foo');

    const { fn, calls } = makeRequestFn([
      {
        name: 'ProjectCreate',
        data: {
          projectCreate: {
            id: 'proj-1',
            name: 'acme',
            environments: {
              edges: [{ node: { id: 'env-1', name: 'production' } }],
            },
          },
        },
      },
      { name: 'ServiceCreate', data: { serviceCreate: { id: 'svc-1' } } },
      { name: 'VariableCollectionUpsert', data: { variableCollectionUpsert: true } },
      {
        name: 'ServiceDomainCreate',
        data: { serviceDomainCreate: { domain: 'acme.up.railway.app' } },
      },
    ]);

    const result = await deployProjectToRailway(
      { projectName: 'acme', projectPath: dir, githubRepo: 'me/acme', token: 'tok' },
      { requestFn: fn }
    );

    expect(result).toMatchObject({
      railwayProjectId: 'proj-1',
      serviceId: 'svc-1',
      deploymentUrl: 'https://acme.up.railway.app',
      repo: 'me/acme',
      envVarCount: 1,
    });

    expect(calls[0].query).toContain('ProjectCreate');
    expect(calls[1].query).toContain('ServiceCreate');
    expect(calls[1].variables.input.source.repo).toBe('me/acme');
    expect(calls[2].query).toContain('VariableCollectionUpsert');
    expect(calls[2].variables.input.variables).toEqual({
      DATABASE_URL: 'postgres://foo',
    });
    expect(calls[3].query).toContain('ServiceDomainCreate');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces a helpful error and cleans up the empty project when GitHub App is not installed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rw-'));
    const { fn, calls } = makeRequestFn([
      {
        name: 'ProjectCreate',
        data: {
          projectCreate: {
            id: 'proj-1',
            name: 'acme',
            environments: { edges: [{ node: { id: 'env-1', name: 'production' } }] },
          },
        },
      },
      { name: 'ServiceCreate', error: 'GitHub repo not accessible. Install the GitHub App.' },
      { name: 'ProjectDelete', data: { projectDelete: true } },
    ]);

    await expect(
      deployProjectToRailway(
        { projectName: 'acme', projectPath: dir, githubRepo: 'me/acme', token: 'tok' },
        { requestFn: fn }
      )
    ).rejects.toThrow(/Railway GitHub App|Railway could not access/i);

    const deleteCall = calls.find(c => c.query.includes('ProjectDelete'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall.variables.id).toBe('proj-1');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('still returns success if domain creation fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rw-'));
    const { fn } = makeRequestFn([
      {
        name: 'ProjectCreate',
        data: {
          projectCreate: {
            id: 'proj-1',
            name: 'acme',
            environments: { edges: [{ node: { id: 'env-1', name: 'production' } }] },
          },
        },
      },
      { name: 'ServiceCreate', data: { serviceCreate: { id: 'svc-1' } } },
      { name: 'VariableCollectionUpsert', data: { variableCollectionUpsert: true } },
      { name: 'ServiceDomainCreate', error: 'Domain creation failed' },
    ]);

    const result = await deployProjectToRailway(
      { projectName: 'acme', projectPath: dir, githubRepo: 'me/acme', token: 'tok' },
      { requestFn: fn }
    );
    expect(result.deploymentUrl).toBeNull();
    expect(result.railwayProjectId).toBe('proj-1');
    expect(result.environmentId).toBe('env-1');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('stripAnsi', () => {
  it('removes ANSI color escapes', () => {
    const sample = 'vite.config.js [33m[WARNING][0m message';
    expect(stripAnsi(sample)).toBe('vite.config.js [WARNING] message');
  });

  it('returns empty string for null/undefined input', () => {
    expect(stripAnsi(null)).toBe('');
    expect(stripAnsi(undefined)).toBe('');
    expect(stripAnsi('')).toBe('');
  });

  it('leaves text with no escapes untouched', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('getLatestDeployment', () => {
  it('returns the most recent deployment node', async () => {
    const requestFn = vi.fn(async () => ({
      service: {
        deployments: {
          edges: [{ node: { id: 'd-1', status: 'SUCCESS', createdAt: 'now', staticUrl: 'x.up.railway.app' } }],
        },
      },
    }));
    const result = await getLatestDeployment('svc-1', 'tok', requestFn);
    expect(result).toEqual({ id: 'd-1', status: 'SUCCESS', createdAt: 'now', staticUrl: 'x.up.railway.app' });
    expect(requestFn).toHaveBeenCalledOnce();
    expect(requestFn.mock.calls[0][1]).toEqual({ id: 'svc-1' });
  });

  it('returns null when the service has no deployments', async () => {
    const requestFn = vi.fn(async () => ({ service: { deployments: { edges: [] } } }));
    expect(await getLatestDeployment('svc-1', 'tok', requestFn)).toBeNull();
  });

  it('returns null when the service is missing', async () => {
    const requestFn = vi.fn(async () => ({ service: null }));
    expect(await getLatestDeployment('svc-1', 'tok', requestFn)).toBeNull();
  });
});

describe('getBuildLogs', () => {
  it('concatenates messages and strips ANSI', async () => {
    const requestFn = vi.fn(async () => ({
      buildLogs: [
        { message: 'line one\n', severity: 'info', timestamp: 't1' },
        { message: '[31mERROR[0m line two\n', severity: 'error', timestamp: 't2' },
      ],
    }));
    const logs = await getBuildLogs('d-1', 'tok', { requestFn });
    expect(logs).toBe('line one\nERROR line two\n');
  });

  it('returns empty string when there are no logs', async () => {
    const requestFn = vi.fn(async () => ({ buildLogs: [] }));
    expect(await getBuildLogs('d-1', 'tok', { requestFn })).toBe('');
  });

  it('sends the limit parameter to Railway', async () => {
    const requestFn = vi.fn(async () => ({ buildLogs: [] }));
    await getBuildLogs('d-1', 'tok', { limit: 25, requestFn });
    expect(requestFn.mock.calls[0][1]).toEqual({ id: 'd-1', limit: 25 });
  });
});
