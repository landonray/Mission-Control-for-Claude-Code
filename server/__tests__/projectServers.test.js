import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseEnvFile,
  readEnvFile,
  getPinnedPorts,
  pathIsInside,
  detectServers,
  killServer,
  listProjectProcesses,
  detectExtras,
  killAllProjectProcesses,
} from '../services/projectServers.js';

describe('parseEnvFile', () => {
  it('parses simple KEY=VALUE lines', () => {
    const env = parseEnvFile('PORT=3001\nVITE_PORT=5173');
    expect(env).toEqual({ PORT: '3001', VITE_PORT: '5173' });
  });

  it('ignores comments and blanks', () => {
    const env = parseEnvFile('# comment\nPORT=3001\n\n# another\nFOO=bar');
    expect(env).toEqual({ PORT: '3001', FOO: 'bar' });
  });

  it('strips surrounding quotes', () => {
    const env = parseEnvFile('A="hello"\nB=\'world\'');
    expect(env).toEqual({ A: 'hello', B: 'world' });
  });

  it('keeps = inside values', () => {
    const env = parseEnvFile('DATABASE_URL=postgres://user:pass@host/db?sslmode=require');
    expect(env.DATABASE_URL).toBe('postgres://user:pass@host/db?sslmode=require');
  });

  it('skips malformed lines', () => {
    const env = parseEnvFile('NOEQUALSHERE\nOK=yes');
    expect(env).toEqual({ OK: 'yes' });
  });
});

describe('readEnvFile', () => {
  it('returns empty object if .env is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-env-'));
    expect(readEnvFile(dir)).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads an existing .env file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-env-'));
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=4001');
    expect(readEnvFile(dir)).toEqual({ PORT: '4001' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('getPinnedPorts', () => {
  it('returns only valid numeric PORT and VITE_PORT', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-env-'));
    fs.writeFileSync(
      path.join(dir, '.env'),
      'PORT=4001\nVITE_PORT=5173\nOTHER=foo'
    );
    expect(getPinnedPorts(dir)).toEqual({ PORT: 4001, VITE_PORT: 5173 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores non-numeric or out-of-range ports', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-env-'));
    fs.writeFileSync(
      path.join(dir, '.env'),
      'PORT=abc\nVITE_PORT=99999'
    );
    expect(getPinnedPorts(dir)).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('pathIsInside', () => {
  it('treats identical paths as inside', () => {
    expect(pathIsInside('/foo/bar', '/foo/bar')).toBe(true);
  });

  it('recognizes nested paths', () => {
    expect(pathIsInside('/foo/bar/baz', '/foo/bar')).toBe(true);
  });

  it('rejects sibling paths with shared prefix', () => {
    expect(pathIsInside('/foo/bar-evil', '/foo/bar')).toBe(false);
  });

  it('rejects unrelated paths', () => {
    expect(pathIsInside('/etc/passwd', '/foo/bar')).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(pathIsInside(null, '/foo')).toBe(false);
    expect(pathIsInside('/foo', null)).toBe(false);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'matches paths that differ only in case on case-insensitive filesystems',
    () => {
      expect(
        pathIsInside(
          '/Users/me/Coding Projects/MyApp',
          '/Users/me/coding projects/MyApp'
        )
      ).toBe(true);
    }
  );
});

describe('detectServers', () => {
  const projectPath = '/Users/me/proj';

  it('marks a port as running when listener is present and cwd is in the project', () => {
    const servers = detectServers(projectPath, {
      getPinnedPorts: () => ({ PORT: 4001, VITE_PORT: 5173 }),
      getListenerOnPort: (port) =>
        port === 4001 ? { pid: 1234, command: 'node' } : null,
      getProcessCwd: (pid) => (pid === 1234 ? projectPath : null),
    });

    const backend = servers.find(s => s.role === 'Backend');
    const frontend = servers.find(s => s.role === 'Frontend');
    expect(backend).toMatchObject({
      port: 4001, running: true, pid: 1234, belongsToProject: true,
    });
    expect(frontend).toMatchObject({
      port: 5173, running: false,
    });
  });

  it('flags foreign processes as not belonging to the project', () => {
    const servers = detectServers(projectPath, {
      getPinnedPorts: () => ({ PORT: 4001 }),
      getListenerOnPort: () => ({ pid: 9999, command: 'python' }),
      getProcessCwd: () => '/some/other/proj',
    });
    expect(servers[0].belongsToProject).toBe(false);
  });

  it('returns not-configured rows when port is missing in env', () => {
    const servers = detectServers(projectPath, {
      getPinnedPorts: () => ({}),
      getListenerOnPort: () => null,
      getProcessCwd: () => null,
    });
    expect(servers).toHaveLength(2);
    expect(servers[0]).toEqual({ key: 'PORT', role: 'Backend', port: null, running: false });
  });
});

describe('killServer', () => {
  const projectPath = '/Users/me/proj';

  it('kills a process whose cwd is inside the project', () => {
    const kill = vi.fn();
    const result = killServer(projectPath, 5678, {
      getProcessCwd: () => `${projectPath}/sub`,
      kill,
    });
    expect(result).toEqual({ killed: true, pid: 5678 });
    expect(kill).toHaveBeenCalledWith(5678, 'SIGTERM');
  });

  it('refuses to kill a process whose cwd is outside the project', () => {
    const kill = vi.fn();
    expect(() =>
      killServer(projectPath, 5678, {
        getProcessCwd: () => '/some/other/proj',
        kill,
      })
    ).toThrow(/Refusing to kill/);
    expect(kill).not.toHaveBeenCalled();
  });

  it('refuses suspiciously small PIDs', () => {
    const kill = vi.fn();
    expect(() =>
      killServer(projectPath, 0, { getProcessCwd: () => projectPath, kill })
    ).toThrow(/Invalid PID/);
    expect(() =>
      killServer(projectPath, 1, { getProcessCwd: () => projectPath, kill })
    ).toThrow(/Invalid PID/);
    expect(kill).not.toHaveBeenCalled();
  });

  it('errors when the process cwd cannot be read', () => {
    const kill = vi.fn();
    expect(() =>
      killServer(projectPath, 5678, { getProcessCwd: () => null, kill })
    ).toThrow(/not found or has no cwd/);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('listProjectProcesses', () => {
  const projectPath = '/Users/me/proj';

  const makeListAll = (procs) => () => procs;
  const cwdMap = (map) => (pid) => map[pid] ?? null;

  it('returns dev processes whose cwd is inside the project', () => {
    const result = listProjectProcesses(projectPath, {
      listAllProcesses: makeListAll([
        { pid: 100, ppid: 1, command: 'npm run dev' },
        { pid: 101, ppid: 100, command: 'node server/index.js' },
        { pid: 102, ppid: 100, command: '/path/to/.bin/vite' },
      ]),
      getProcessCwd: cwdMap({
        100: projectPath,
        101: `${projectPath}/server`,
        102: `${projectPath}/client`,
      }),
    });
    expect(result.map((p) => p.pid).sort()).toEqual([100, 101, 102]);
    expect(result.find((p) => p.pid === 100).cwd).toBe(projectPath);
  });

  it('excludes processes whose cwd is in another project', () => {
    const result = listProjectProcesses(projectPath, {
      listAllProcesses: makeListAll([
        { pid: 200, ppid: 1, command: 'node index.js' },
        { pid: 201, ppid: 1, command: 'npm run dev' },
      ]),
      getProcessCwd: cwdMap({
        200: projectPath,
        201: '/Users/me/other-proj',
      }),
    });
    expect(result.map((p) => p.pid)).toEqual([200]);
  });

  it('excludes non-dev processes even if cwd is inside the project', () => {
    const result = listProjectProcesses(projectPath, {
      listAllProcesses: makeListAll([
        { pid: 300, ppid: 1, command: '/Applications/Slack.app/Slack' },
        { pid: 301, ppid: 1, command: 'python manage.py runserver' },
        { pid: 302, ppid: 1, command: 'node server/index.js' },
      ]),
      getProcessCwd: cwdMap({
        300: projectPath,
        301: projectPath,
        302: projectPath,
      }),
    });
    expect(result.map((p) => p.pid)).toEqual([302]);
  });

  it('excludes the calling server itself', () => {
    const result = listProjectProcesses(projectPath, {
      listAllProcesses: makeListAll([
        { pid: process.pid, ppid: 1, command: 'node server/index.js' },
        { pid: 401, ppid: 1, command: 'node server/index.js' },
      ]),
      getProcessCwd: cwdMap({
        [process.pid]: projectPath,
        401: projectPath,
      }),
    });
    expect(result.map((p) => p.pid)).toEqual([401]);
  });

  it('handles processes that exit between ps and lsof (null cwd)', () => {
    const result = listProjectProcesses(projectPath, {
      listAllProcesses: makeListAll([
        { pid: 500, ppid: 1, command: 'node server/index.js' },
        { pid: 501, ppid: 1, command: 'vite' },
      ]),
      getProcessCwd: cwdMap({
        500: projectPath,
        501: null, // exited between calls
      }),
    });
    expect(result.map((p) => p.pid)).toEqual([500]);
  });
});

describe('detectExtras', () => {
  const projectPath = '/Users/me/proj';

  it('returns project processes that are not the port holders', () => {
    const fakeServers = [
      { key: 'PORT', role: 'Backend', port: 4001, running: true, pid: 101, belongsToProject: true },
      { key: 'VITE_PORT', role: 'Frontend', port: 5173, running: true, pid: 102, belongsToProject: true },
    ];
    const extras = detectExtras(projectPath, {
      detectServers: () => fakeServers,
      listProjectProcesses: () => [
        { pid: 100, ppid: 1, command: 'npm run dev', cwd: projectPath },
        { pid: 101, ppid: 100, command: 'node server/index.js', cwd: projectPath },
        { pid: 102, ppid: 100, command: 'vite', cwd: projectPath },
        { pid: 103, ppid: 1, command: 'node zombie.js', cwd: projectPath },
      ],
    });
    expect(extras.map((p) => p.pid).sort()).toEqual([100, 103]);
  });

  it('returns all project processes when no port holders exist', () => {
    const extras = detectExtras(projectPath, {
      detectServers: () => [
        { key: 'PORT', role: 'Backend', port: 4001, running: false },
        { key: 'VITE_PORT', role: 'Frontend', port: 5173, running: false },
      ],
      listProjectProcesses: () => [
        { pid: 700, ppid: 1, command: 'npm run dev', cwd: projectPath },
      ],
    });
    expect(extras.map((p) => p.pid)).toEqual([700]);
  });

  it('returns empty when no dev processes are running for the project', () => {
    const extras = detectExtras(projectPath, {
      detectServers: () => [],
      listProjectProcesses: () => [],
    });
    expect(extras).toEqual([]);
  });
});

describe('killAllProjectProcesses', () => {
  const projectPath = '/Users/me/proj';

  it('kills every project-owned process with SIGTERM', () => {
    const kill = vi.fn();
    const result = killAllProjectProcesses(projectPath, {
      listProjectProcesses: () => [
        { pid: 100, ppid: 1, command: 'npm run dev', cwd: projectPath },
        { pid: 101, ppid: 100, command: 'node server/index.js', cwd: projectPath },
        { pid: 102, ppid: 100, command: 'vite', cwd: projectPath },
      ],
      getProcessCwd: () => projectPath,
      kill,
    });
    expect(result.killed.sort()).toEqual([100, 101, 102]);
    expect(result.failed).toEqual([]);
    expect(kill).toHaveBeenCalledTimes(3);
    for (const call of kill.mock.calls) {
      expect(call[1]).toBe('SIGTERM');
    }
  });

  it('records failures without aborting the sweep', () => {
    let n = 0;
    const kill = vi.fn(() => {
      n += 1;
      if (n === 2) throw new Error('ESRCH: no such process');
    });
    const result = killAllProjectProcesses(projectPath, {
      listProjectProcesses: () => [
        { pid: 100, ppid: 1, command: 'npm', cwd: projectPath },
        { pid: 101, ppid: 100, command: 'node', cwd: projectPath },
        { pid: 102, ppid: 100, command: 'vite', cwd: projectPath },
      ],
      getProcessCwd: () => projectPath,
      kill,
    });
    expect(result.killed.sort()).toEqual([100, 102]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].pid).toBe(101);
    expect(result.failed[0].error).toMatch(/ESRCH/);
  });

  it('returns empty result when there are no processes to kill', () => {
    const kill = vi.fn();
    const result = killAllProjectProcesses(projectPath, {
      listProjectProcesses: () => [],
      getProcessCwd: () => null,
      kill,
    });
    expect(result).toEqual({ killed: [], failed: [] });
    expect(kill).not.toHaveBeenCalled();
  });

  it('skips a process whose cwd moved outside the project between list and kill', () => {
    const kill = vi.fn();
    const result = killAllProjectProcesses(projectPath, {
      listProjectProcesses: () => [
        { pid: 100, ppid: 1, command: 'node', cwd: projectPath },
      ],
      // At kill-time cwd now reports a different path; killServer should refuse.
      getProcessCwd: () => '/some/other/proj',
      kill,
    });
    expect(result.killed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/Refusing to kill/);
    expect(kill).not.toHaveBeenCalled();
  });
});
