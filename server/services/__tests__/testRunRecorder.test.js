import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub DATABASE_URL so the database module can be required without crashing.
// The real query function is replaced via the recorder's test seam below.
process.env.DATABASE_URL ||= 'postgres://stub:stub@stub.invalid/stub';

const recorder = await import('../testRunRecorder.js');

function flushPromises() {
  return new Promise(resolve => setImmediate(resolve));
}

describe('testRunRecorder', () => {
  let broadcasts;
  let mockQuery;
  let mockParse;

  beforeEach(() => {
    mockQuery = vi.fn();
    mockParse = vi.fn();
    recorder._setQueryForTests(mockQuery);
    recorder._setParserForTests(mockParse);
    broadcasts = [];
    recorder.setBroadcast(msg => broadcasts.push(msg));
    recorder._resetPendingForTests();
  });

  afterEach(() => {
    recorder._resetForTests();
  });

  it('ignores Bash tool_use that is not a test command', async () => {
    recorder.onBashToolUse('s1', 'tu1', { command: 'ls -la' });
    await recorder.onToolResult('s1', { type: 'tool_result', tool_use_id: 'tu1', content: '' });

    expect(mockQuery).not.toHaveBeenCalled();
    expect(broadcasts).toHaveLength(0);
  });

  it('records a test_run when a tracked Bash command finishes', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ project_id: 'p1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    mockParse.mockResolvedValue({
      status: 'failed',
      total: 5,
      passed: 4,
      failed: 1,
      failures: [{ name: 'foo bar', file: 'foo.test.js', message: 'expected x got y' }],
    });

    recorder.onBashToolUse('s1', 'tu1', { command: 'npx vitest run' });
    await recorder.onToolResult('s1', {
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: 'TEST OUTPUT',
    });

    await flushPromises();
    await flushPromises();

    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery.mock.calls[1][0]).toContain('INSERT INTO test_runs');
    expect(mockQuery.mock.calls[2][0]).toContain('UPDATE test_runs');

    const insertParams = mockQuery.mock.calls[1][1];
    expect(insertParams[1]).toBe('p1');
    expect(insertParams[2]).toBe('s1');
    expect(insertParams[3]).toBe('npx vitest run');
    expect(insertParams[4]).toBe('vitest');
    expect(insertParams[5]).toBe('parsing');

    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[0].type).toBe('test_run_started');
    expect(broadcasts[0].projectId).toBe('p1');
    expect(broadcasts[1].type).toBe('test_run_completed');
    expect(broadcasts[1].run.status).toBe('failed');
    expect(broadcasts[1].run.failed).toBe(1);
  });

  it('falls back to status=unknown if the parser throws', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ project_id: 'p1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    mockParse.mockRejectedValue(new Error('parser blew up'));

    recorder.onBashToolUse('s1', 'tu1', { command: 'pytest' });
    await recorder.onToolResult('s1', { type: 'tool_result', tool_use_id: 'tu1', content: '' });

    await flushPromises();
    await flushPromises();

    expect(mockQuery.mock.calls[2][0]).toContain('UPDATE test_runs');
    expect(broadcasts[1].run.status).toBe('unknown');
    expect(broadcasts[1].run.failures[0].message).toContain('parser blew up');
  });

  it('only matches the recorded tool_use_id', async () => {
    recorder.onBashToolUse('s1', 'tu1', { command: 'jest' });
    await recorder.onToolResult('s1', { type: 'tool_result', tool_use_id: 'something_else', content: '' });

    expect(mockQuery).not.toHaveBeenCalled();
    expect(broadcasts).toHaveLength(0);
  });

  it('flattens array content from tool_result blocks', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ project_id: 'p1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    mockParse.mockResolvedValue({ status: 'passed', total: 1, passed: 1, failed: 0, failures: [] });

    recorder.onBashToolUse('s1', 'tu1', { command: 'pytest' });
    await recorder.onToolResult('s1', {
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: [
        { type: 'text', text: 'collected 1 item' },
        { type: 'text', text: '1 passed in 0.05s' },
      ],
    });

    await flushPromises();

    expect(mockParse).toHaveBeenCalledTimes(1);
    const parsedInput = mockParse.mock.calls[0][0];
    expect(parsedInput).toContain('collected 1 item');
    expect(parsedInput).toContain('1 passed in 0.05s');
  });
});
