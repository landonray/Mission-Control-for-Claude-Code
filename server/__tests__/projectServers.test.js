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
