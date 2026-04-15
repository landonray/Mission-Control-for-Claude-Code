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

      it('rejects path traversal in schema path', () => {
        const result = runCheck({ type: 'json_schema', schema: '../../etc/passwd' }, '{"a": 1}', { projectRoot: '/tmp' });
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('Path traversal denied');
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

    describe('equals', () => {
      it('passes when evidence matches value exactly', () => {
        const result = runCheck({ type: 'equals', value: 'hello' }, 'hello');
        expect(result.passed).toBe(true);
        expect(result.reason).toContain('equals');
      });

      it('fails when evidence does not match', () => {
        const result = runCheck({ type: 'equals', value: 'hello' }, 'world');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('Expected "hello"');
      });

      it('compares as strings (numeric coercion)', () => {
        const result = runCheck({ type: 'equals', value: 42 }, '42');
        expect(result.passed).toBe(true);
      });

      it('extracts value from JSON field', () => {
        const result = runCheck(
          { type: 'equals', value: 'active', field: 'status' },
          '{"status": "active"}'
        );
        expect(result.passed).toBe(true);
      });

      it('supports nested JSON field', () => {
        const result = runCheck(
          { type: 'equals', value: 'admin', field: 'user.role' },
          '{"user": {"role": "admin"}}'
        );
        expect(result.passed).toBe(true);
      });

      it('fails when JSON field not found', () => {
        const result = runCheck(
          { type: 'equals', value: 'x', field: 'missing' },
          '{"a": 1}'
        );
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('not found');
      });

      it('fails when field specified but evidence is not JSON', () => {
        const result = runCheck(
          { type: 'equals', value: 'x', field: 'status' },
          'not json'
        );
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('not valid JSON');
      });

      it('fails when no value specified', () => {
        const result = runCheck({ type: 'equals' }, 'evidence');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('No "value"');
      });
    });

    describe('contains', () => {
      it('passes when evidence contains value', () => {
        const result = runCheck({ type: 'contains', value: 'world' }, 'hello world!');
        expect(result.passed).toBe(true);
      });

      it('fails when evidence does not contain value', () => {
        const result = runCheck({ type: 'contains', value: 'xyz' }, 'hello world');
        expect(result.passed).toBe(false);
      });

      it('is case-sensitive', () => {
        const result = runCheck({ type: 'contains', value: 'Hello' }, 'hello world');
        expect(result.passed).toBe(false);
      });

      it('works with JSON field extraction', () => {
        const result = runCheck(
          { type: 'contains', value: 'error', field: 'message' },
          '{"message": "An error occurred"}'
        );
        expect(result.passed).toBe(true);
      });

      it('fails when no value specified', () => {
        const result = runCheck({ type: 'contains' }, 'evidence');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('No "value"');
      });
    });

    describe('greater_than', () => {
      it('passes when evidence is greater than threshold', () => {
        const result = runCheck({ type: 'greater_than', value: 5 }, '10');
        expect(result.passed).toBe(true);
        expect(result.reason).toContain('10 > 5');
      });

      it('fails when evidence equals threshold', () => {
        const result = runCheck({ type: 'greater_than', value: 5 }, '5');
        expect(result.passed).toBe(false);
      });

      it('fails when evidence is less than threshold', () => {
        const result = runCheck({ type: 'greater_than', value: 10 }, '5');
        expect(result.passed).toBe(false);
      });

      it('works with decimal numbers', () => {
        const result = runCheck({ type: 'greater_than', value: 0.5 }, '0.75');
        expect(result.passed).toBe(true);
      });

      it('extracts from JSON field', () => {
        const result = runCheck(
          { type: 'greater_than', value: 90, field: 'metrics.accuracy' },
          '{"metrics": {"accuracy": 95.5}}'
        );
        expect(result.passed).toBe(true);
      });

      it('fails when evidence is not a number', () => {
        const result = runCheck({ type: 'greater_than', value: 5 }, 'not a number');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('not a number');
      });

      it('fails when no value specified', () => {
        const result = runCheck({ type: 'greater_than' }, '10');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('No "value"');
      });
    });

    describe('less_than', () => {
      it('passes when evidence is less than threshold', () => {
        const result = runCheck({ type: 'less_than', value: 10 }, '5');
        expect(result.passed).toBe(true);
        expect(result.reason).toContain('5 < 10');
      });

      it('fails when evidence equals threshold', () => {
        const result = runCheck({ type: 'less_than', value: 5 }, '5');
        expect(result.passed).toBe(false);
      });

      it('fails when evidence is greater than threshold', () => {
        const result = runCheck({ type: 'less_than', value: 5 }, '10');
        expect(result.passed).toBe(false);
      });

      it('works with negative numbers', () => {
        const result = runCheck({ type: 'less_than', value: 0 }, '-5');
        expect(result.passed).toBe(true);
      });

      it('extracts from JSON field', () => {
        const result = runCheck(
          { type: 'less_than', value: 100, field: 'latency_ms' },
          '{"latency_ms": 42}'
        );
        expect(result.passed).toBe(true);
      });

      it('fails when evidence is not a number', () => {
        const result = runCheck({ type: 'less_than', value: 5 }, 'abc');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('not a number');
      });
    });

    describe('numeric_score', () => {
      it('passes and records score with no thresholds', () => {
        const result = runCheck({ type: 'numeric_score' }, '85');
        expect(result.passed).toBe(true);
        expect(result.score).toBe(85);
        expect(result.reason).toContain('Score: 85');
      });

      it('passes when score is within min/max range', () => {
        const result = runCheck({ type: 'numeric_score', min: 0, max: 100 }, '75');
        expect(result.passed).toBe(true);
        expect(result.score).toBe(75);
        expect(result.reason).toContain('within range');
      });

      it('fails when score is below min', () => {
        const result = runCheck({ type: 'numeric_score', min: 80 }, '65');
        expect(result.passed).toBe(false);
        expect(result.score).toBe(65);
        expect(result.reason).toContain('below min 80');
      });

      it('fails when score is above max', () => {
        const result = runCheck({ type: 'numeric_score', max: 100 }, '150');
        expect(result.passed).toBe(false);
        expect(result.score).toBe(150);
        expect(result.reason).toContain('above max 100');
      });

      it('reports both violations when outside range', () => {
        const result = runCheck({ type: 'numeric_score', min: 50, max: 40 }, '45');
        // 45 > max 40 but < min 50 — unusual config but both should report
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('below min 50');
        expect(result.reason).toContain('above max 40');
      });

      it('extracts from JSON field', () => {
        const result = runCheck(
          { type: 'numeric_score', field: 'score', min: 70 },
          '{"score": 92}'
        );
        expect(result.passed).toBe(true);
        expect(result.score).toBe(92);
      });

      it('fails when evidence is not a number', () => {
        const result = runCheck({ type: 'numeric_score' }, 'not a number');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('not a number');
      });

      it('works with only min threshold', () => {
        const result = runCheck({ type: 'numeric_score', min: 0 }, '42');
        expect(result.passed).toBe(true);
        expect(result.score).toBe(42);
      });

      it('works with only max threshold', () => {
        const result = runCheck({ type: 'numeric_score', max: 1000 }, '500');
        expect(result.passed).toBe(true);
        expect(result.score).toBe(500);
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
