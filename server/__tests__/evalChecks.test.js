import { describe, it, expect } from 'vitest';
import { runCheck, runAllChecks } from '../services/evalChecks.js';

describe('evalChecks', () => {
  describe('runCheck', () => {
    describe('regex_match', () => {
      it('passes when pattern matches evidence', () => {
        const result = runCheck({ type: 'regex_match', pattern: 'hello\\s+world' }, 'say hello  world!');
        expect(result.passed).toBe(true);
        expect(result.type).toBe('regex_match');
      });

      it('fails when pattern does not match', () => {
        const result = runCheck({ type: 'regex_match', pattern: 'xyz123' }, 'no match here');
        expect(result.passed).toBe(false);
      });

      it('supports regex flags', () => {
        const result = runCheck({ type: 'regex_match', pattern: 'HELLO', flags: 'i' }, 'hello');
        expect(result.passed).toBe(true);
      });

      it('fails when no pattern is specified', () => {
        const result = runCheck({ type: 'regex_match' }, 'evidence');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('No pattern');
      });

      it('handles invalid regex gracefully', () => {
        const result = runCheck({ type: 'regex_match', pattern: '[invalid(' }, 'evidence');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('Invalid regex');
      });
    });

    describe('not_empty', () => {
      it('passes for non-empty evidence', () => {
        expect(runCheck({ type: 'not_empty' }, 'some content').passed).toBe(true);
      });

      it('fails for null evidence', () => {
        expect(runCheck({ type: 'not_empty' }, null).passed).toBe(false);
      });

      it('fails for empty string', () => {
        expect(runCheck({ type: 'not_empty' }, '').passed).toBe(false);
      });

      it('fails for whitespace-only string', () => {
        expect(runCheck({ type: 'not_empty' }, '   \n  ').passed).toBe(false);
      });
    });

    describe('json_valid', () => {
      it('passes for valid JSON', () => {
        expect(runCheck({ type: 'json_valid' }, '{"key": "value"}').passed).toBe(true);
      });

      it('fails for invalid JSON', () => {
        expect(runCheck({ type: 'json_valid' }, 'not json').passed).toBe(false);
      });

      it('passes for JSON array', () => {
        expect(runCheck({ type: 'json_valid' }, '[1, 2, 3]').passed).toBe(true);
      });
    });

    describe('json_schema', () => {
      it('fails when no schema is specified', () => {
        const result = runCheck({ type: 'json_schema' }, '{"a": 1}');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('No schema specified');
      });

      it('fails for invalid JSON evidence', () => {
        expect(runCheck({ type: 'json_schema', schema: 'test.json' }, 'nope').passed).toBe(false);
        expect(runCheck({ type: 'json_schema', schema: 'test.json' }, 'nope').reason).toContain('not valid JSON');
      });

      it('fails when no project root in context', () => {
        const result = runCheck({ type: 'json_schema', schema: 'test.json' }, '{"a": 1}');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('no project root');
      });

      it('fails when schema file does not exist', () => {
        const result = runCheck({ type: 'json_schema', schema: 'nonexistent.json' }, '{"a": 1}', { projectRoot: '/tmp' });
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('Failed to load schema');
      });
    });

    describe('http_status', () => {
      it('passes when status code found in evidence', () => {
        const result = runCheck({ type: 'http_status', status: 200 }, 'HTTP/1.1 200 OK');
        expect(result.passed).toBe(true);
      });

      it('fails when status code not found', () => {
        const result = runCheck({ type: 'http_status', status: 404 }, 'HTTP/1.1 200 OK');
        expect(result.passed).toBe(false);
      });

      it('fails when no status specified', () => {
        const result = runCheck({ type: 'http_status' }, 'HTTP/1.1 200 OK');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('No status code');
      });
    });

    describe('field_exists', () => {
      it('passes when field exists in JSON', () => {
        const result = runCheck({ type: 'field_exists', field: 'name' }, '{"name": "test"}');
        expect(result.passed).toBe(true);
      });

      it('fails when field does not exist', () => {
        const result = runCheck({ type: 'field_exists', field: 'missing' }, '{"name": "test"}');
        expect(result.passed).toBe(false);
      });

      it('supports nested dot notation', () => {
        const result = runCheck(
          { type: 'field_exists', field: 'user.email' },
          '{"user": {"email": "a@b.com"}}'
        );
        expect(result.passed).toBe(true);
      });

      it('fails when evidence is not JSON', () => {
        const result = runCheck({ type: 'field_exists', field: 'x' }, 'not json');
        expect(result.passed).toBe(false);
      });

      it('fails when no field specified', () => {
        const result = runCheck({ type: 'field_exists' }, '{"a": 1}');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('No field');
      });
    });

    it('returns failure for unknown check type', () => {
      const result = runCheck({ type: 'unknown_type' }, 'evidence');
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('Unknown check type');
    });

    it('includes description from check definition', () => {
      const result = runCheck({ type: 'not_empty', description: 'Output should exist' }, 'data');
      expect(result.description).toBe('Output should exist');
    });
  });

  describe('runAllChecks', () => {
    it('returns allPassed true when all checks pass', () => {
      const checks = [
        { type: 'not_empty' },
        { type: 'json_valid' },
      ];
      const result = runAllChecks(checks, '{"a": 1}');
      expect(result.allPassed).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.failures).toHaveLength(0);
    });

    it('returns allPassed false when any check fails', () => {
      const checks = [
        { type: 'not_empty' },
        { type: 'regex_match', pattern: 'xyz' },
      ];
      const result = runAllChecks(checks, 'hello');
      expect(result.allPassed).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].type).toBe('regex_match');
    });

    it('runs all checks even when some fail (no short-circuit)', () => {
      const checks = [
        { type: 'regex_match', pattern: 'nope' },
        { type: 'regex_match', pattern: 'also_nope' },
        { type: 'not_empty' },
      ];
      const result = runAllChecks(checks, 'hello');
      expect(result.results).toHaveLength(3);
      expect(result.failures).toHaveLength(2);
    });
  });
});
