import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseTestOutput,
  _internal,
  _setRunnerForTests,
  _resetRunnerForTests,
} from '../testRunParser.js';

describe('testRunParser — _internal helpers', () => {
  it('extracts JSON from a plain JSON string', () => {
    const out = _internal.extractJson('{"status":"passed","total":3,"passed":3,"failed":0,"failures":[]}');
    expect(out).toEqual({ status: 'passed', total: 3, passed: 3, failed: 0, failures: [] });
  });

  it('extracts JSON from a fenced code block', () => {
    const out = _internal.extractJson('```json\n{"status":"failed","failures":[]}\n```');
    expect(out).toEqual({ status: 'failed', failures: [] });
  });

  it('extracts JSON when wrapped in commentary', () => {
    const out = _internal.extractJson('Sure, here is the result: {"status":"passed"} all done!');
    expect(out).toEqual({ status: 'passed' });
  });

  it('returns null on unparseable output', () => {
    expect(_internal.extractJson('not json at all')).toBe(null);
    expect(_internal.extractJson('')).toBe(null);
  });

  it('strips ANSI escape sequences', () => {
    const stripped = _internal.stripAnsi('[31mFAIL[0m something');
    expect(stripped).toBe('FAIL something');
  });

  it('truncateForPrompt keeps short text intact', () => {
    expect(_internal.truncateForPrompt('hello')).toBe('hello');
  });

  it('truncateForPrompt drops the middle of long text', () => {
    const big = 'A'.repeat(20000);
    const out = _internal.truncateForPrompt(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('output truncated');
  });

  it('normalize coerces fields and clamps message length', () => {
    const out = _internal.normalize({
      status: 'weird',
      total: '10',
      passed: '8',
      failed: 2,
      failures: [
        { name: 'x', file: 'f.js', message: 'A'.repeat(500) },
        { name: 'y', file: null, message: 'short' },
      ],
    });
    expect(out.status).toBe('unknown');
    expect(out.total).toBe(10);
    expect(out.passed).toBe(8);
    expect(out.failed).toBe(2);
    expect(out.failures[0].message.length).toBe(200);
    expect(out.failures[1].file).toBe(null);
  });
});

describe('testRunParser — parseTestOutput', () => {
  let mockRunner;

  beforeEach(() => {
    mockRunner = vi.fn();
    _setRunnerForTests(mockRunner);
  });

  afterEach(() => {
    _resetRunnerForTests();
  });

  it('returns a structured result when CLI returns valid JSON', async () => {
    mockRunner.mockResolvedValue('{"status":"failed","total":4,"passed":3,"failed":1,"failures":[{"name":"adds two numbers","file":"calc.test.js","message":"expected 5 but got 4"}]}');

    const result = await parseTestOutput('some test output');

    expect(result.status).toBe('failed');
    expect(result.total).toBe(4);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('adds two numbers');
    expect(result.failures[0].file).toBe('calc.test.js');
    expect(result.failures[0].message).toBe('expected 5 but got 4');
  });

  it('returns a fallback result when CLI throws', async () => {
    mockRunner.mockRejectedValue(new Error('boom'));

    const result = await parseTestOutput('output');

    expect(result.status).toBe('unknown');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].message).toContain('boom');
  });

  it('returns a fallback result when CLI returns junk', async () => {
    mockRunner.mockResolvedValue('I am not JSON');

    const result = await parseTestOutput('output');

    expect(result.status).toBe('unknown');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].message).toContain('non-JSON');
  });
});
