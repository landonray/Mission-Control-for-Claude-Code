import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SKIP_ENV_KEYS,
  collectEnvVars,
  deployProjectToRailway,
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
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
