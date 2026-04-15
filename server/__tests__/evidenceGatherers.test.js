import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
  default: { readFileSync: mockReadFileSync, existsSync: mockExistsSync },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  default: { execFile: vi.fn() },
}));

describe('evidenceGatherers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function getModule() {
    return await import('../services/evidenceGatherers.js');
  }

  describe('gatherLogQuery', () => {
    it('reads log file and returns content', async () => {
      mockReadFileSync.mockReturnValue('line1\nline2\nline3');
      const { gatherLogQuery } = await getModule();

      const result = await gatherLogQuery(
        { type: 'log_query', source: 'session' },
        { sessionLogPath: '/logs/session.log' }
      );

      expect(result).toBe('line1\nline2\nline3');
      expect(mockReadFileSync).toHaveBeenCalledWith('/logs/session.log', 'utf8');
    });

    it('applies regex filter when specified', async () => {
      mockReadFileSync.mockReturnValue('INFO: hello\nERROR: bad thing\nINFO: world\nERROR: another bad');
      const { gatherLogQuery } = await getModule();

      const result = await gatherLogQuery(
        { type: 'log_query', source: 'session', filter: 'ERROR:.*' },
        { sessionLogPath: '/logs/session.log' }
      );

      expect(result).toContain('ERROR: bad thing');
      expect(result).toContain('ERROR: another bad');
    });

    it('returns empty string when filter matches nothing', async () => {
      mockReadFileSync.mockReturnValue('INFO: hello\nINFO: world');
      const { gatherLogQuery } = await getModule();

      const result = await gatherLogQuery(
        { type: 'log_query', source: 'session', filter: 'FATAL:.*' },
        { sessionLogPath: '/logs/session.log' }
      );

      expect(result).toBe('');
    });

    it('throws when log source cannot be read', async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });
      const { gatherLogQuery } = await getModule();

      await expect(
        gatherLogQuery(
          { type: 'log_query', source: 'session' },
          { sessionLogPath: '/logs/missing.log' }
        )
      ).rejects.toThrow('Failed to read log source');
    });

    it('resolves build log source', async () => {
      mockReadFileSync.mockReturnValue('build output');
      const { gatherLogQuery } = await getModule();

      const result = await gatherLogQuery(
        { type: 'log_query', source: 'build' },
        { buildOutputPath: '/logs/build.log' }
      );

      expect(mockReadFileSync).toHaveBeenCalledWith('/logs/build.log', 'utf8');
    });
  });

  describe('gatherFile', () => {
    it('reads file from project root', async () => {
      mockReadFileSync.mockReturnValue('file content');
      const { gatherFile } = await getModule();

      const result = await gatherFile(
        { type: 'file', path: 'output/result.txt' },
        { projectRoot: '/project' }
      );

      expect(result).toBe('file content');
    });

    it('throws when no path specified', async () => {
      const { gatherFile } = await getModule();

      await expect(
        gatherFile({ type: 'file' }, { projectRoot: '/project' })
      ).rejects.toThrow('requires a "path" field');
    });

    it('throws when file cannot be read', async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const { gatherFile } = await getModule();

      await expect(
        gatherFile({ type: 'file', path: 'missing.txt' }, { projectRoot: '/project' })
      ).rejects.toThrow('Failed to read file');
    });
  });

  describe('gatherDbQuery', () => {
    it('executes SQL and returns JSON rows', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [{ id: 1, name: 'test' }] }),
        end: vi.fn().mockResolvedValue(undefined),
      };
      const { gatherDbQuery } = await getModule();

      const result = await gatherDbQuery(
        { type: 'db_query', query: 'SELECT * FROM users' },
        { createDbConnection: () => mockDb, dbReadonlyUrl: 'postgres://...' }
      );

      const parsed = JSON.parse(result.split('\n\n[truncated')[0]);
      expect(parsed).toEqual([{ id: 1, name: 'test' }]);
    });

    it('throws when no query specified', async () => {
      const { gatherDbQuery } = await getModule();

      await expect(
        gatherDbQuery({ type: 'db_query' }, {})
      ).rejects.toThrow('requires a "query" field');
    });

    it('throws when no db connection available', async () => {
      const { gatherDbQuery } = await getModule();

      await expect(
        gatherDbQuery({ type: 'db_query', query: 'SELECT 1' }, {})
      ).rejects.toThrow('No database connection available');
    });

    it('closes db connection even on error', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined);
      const mockDb = {
        query: vi.fn().mockRejectedValue(new Error('SQL error')),
        end: mockEnd,
      };
      const { gatherDbQuery } = await getModule();

      await expect(
        gatherDbQuery(
          { type: 'db_query', query: 'BAD SQL' },
          { createDbConnection: () => mockDb }
        )
      ).rejects.toThrow('SQL error');

      expect(mockEnd).toHaveBeenCalled();
    });
  });

  describe('gatherEvidence (dispatcher)', () => {
    it('dispatches to log_query gatherer', async () => {
      mockReadFileSync.mockReturnValue('log content');
      const { gatherEvidence } = await getModule();

      const result = await gatherEvidence(
        { type: 'log_query', source: 'session' },
        { sessionLogPath: '/logs/session.log' }
      );

      expect(result).toBe('log content');
    });

    it('dispatches to file gatherer', async () => {
      mockReadFileSync.mockReturnValue('file data');
      const { gatherEvidence } = await getModule();

      const result = await gatherEvidence(
        { type: 'file', path: 'data.txt' },
        { projectRoot: '/project' }
      );

      expect(result).toBe('file data');
    });

    it('throws for unknown evidence type', async () => {
      const { gatherEvidence } = await getModule();

      await expect(
        gatherEvidence({ type: 'magic' }, {})
      ).rejects.toThrow('Unknown evidence type');
    });
  });

  describe('truncateLogEvidence', () => {
    it('returns content unchanged when under limit', async () => {
      const { truncateLogEvidence } = await getModule();
      const result = truncateLogEvidence('short content', 1024);
      expect(result).toBe('short content');
    });

    it('truncates with head+tail when over limit', async () => {
      const { truncateLogEvidence } = await getModule();
      const content = 'A'.repeat(200);
      const result = truncateLogEvidence(content, 100);
      expect(result).toContain('... [truncated');
      expect(result.length).toBeLessThan(200);
    });

    it('handles empty content', async () => {
      const { truncateLogEvidence } = await getModule();
      expect(truncateLogEvidence('', 1024)).toBe('');
      expect(truncateLogEvidence(null, 1024)).toBe('');
    });
  });

  describe('truncateDbEvidence', () => {
    it('returns full JSON when under limit', async () => {
      const { truncateDbEvidence } = await getModule();
      const rows = [{ id: 1 }, { id: 2 }];
      const result = truncateDbEvidence(rows, 10240);
      expect(JSON.parse(result)).toEqual(rows);
    });

    it('truncates rows when over limit', async () => {
      const { truncateDbEvidence } = await getModule();
      const rows = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        name: `User ${i}`,
        data: 'x'.repeat(50),
      }));
      const result = truncateDbEvidence(rows, 1024);
      expect(result).toContain('truncated');
    });
  });

  describe('interpolateVariables', () => {
    it('replaces ${variables.field} with context values', async () => {
      const { interpolateVariables } = await getModule();
      const result = interpolateVariables(
        'SELECT * FROM ${variables.table}',
        { variables: { table: 'users' } }
      );
      expect(result).toBe('SELECT * FROM users');
    });

    it('replaces ${projectRoot} from context', async () => {
      const { interpolateVariables } = await getModule();
      const result = interpolateVariables(
        '${projectRoot}/output.txt',
        { projectRoot: '/my/project' }
      );
      expect(result).toBe('/my/project/output.txt');
    });

    it('leaves unresolvable variables unchanged', async () => {
      const { interpolateVariables } = await getModule();
      const result = interpolateVariables('${missing.field}', {});
      expect(result).toBe('${missing.field}');
    });

    it('handles null/undefined input', async () => {
      const { interpolateVariables } = await getModule();
      expect(interpolateVariables(null, {})).toBe(null);
      expect(interpolateVariables(undefined, {})).toBe(undefined);
    });
  });
});
