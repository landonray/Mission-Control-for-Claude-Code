import { describe, it, expect } from 'vitest';
import { composeFailureMessage } from '../services/evalReporter.js';

describe('evalReporter', () => {
  describe('composeFailureMessage', () => {
    it('formats a summary with passed, failed, and error evals', () => {
      const results = [
        { evalName: 'check-api', state: 'pass', evalFolder: '/project/evals' },
        { evalName: 'check-db', state: 'fail', evalFolder: '/project/evals', expected: 'DB returns fresh data', evidence: 'query returned old rows', judgeVerdict: { result: 'fail', reasoning: 'Evidence shows stale data', confidence: 0.85 } },
        { evalName: 'check-deploy', state: 'error', evalFolder: '/project/evals', error: 'Connection timeout' },
      ];
      const history = [
        { eval_name: 'check-api', state: 'pass', commit_sha: 'abc123' },
        { eval_name: 'check-db', state: 'pass', commit_sha: 'abc123' },
        { eval_name: 'check-db', state: 'fail', commit_sha: 'def456' },
      ];
      const summary = { total: 3, passed: 1, failed: 1, errors: 1 };

      const msg = composeFailureMessage(results, history, summary);

      expect(msg).toContain('Eval run complete: 3 evals ran, 1 failed, 1 errors.');
      expect(msg).toContain('PASSED: check-api (evals/)');
      expect(msg).toContain('FAILED: check-db (evals/)');
      expect(msg).toContain('Expected: DB returns fresh data');
      expect(msg).toContain('Evidence: query returned old rows');
      expect(msg).toContain('Judge reasoning: "Evidence shows stale data"');
      expect(msg).toContain('Confidence: 0.85');
      expect(msg).toContain('ERROR: check-deploy (evals/)');
      expect(msg).toContain('Connection timeout');
      expect(msg).toContain('(Infrastructure issue, not a regression)');
      expect(msg).toContain('LAST 3 RUNS:');
      expect(msg).toContain('check-db:    FAIL def456 → PASS abc123');
    });

    it('adds low-confidence note when judge confidence is low', () => {
      const results = [
        {
          evalName: 'flaky-eval', state: 'fail', evalFolder: '/project/evals',
          failReason: 'output mismatch',
          judgeVerdict: { result: 'fail', reasoning: 'Unclear evidence', confidence: 'low' },
        },
      ];
      const summary = { total: 1, passed: 0, failed: 1, errors: 0 };

      const msg = composeFailureMessage(results, [], summary);

      expect(msg).toContain('Judge confidence was low — verify before acting on this result.');
    });

    it('does not add low-confidence note when confidence is medium or high', () => {
      const results = [
        {
          evalName: 'solid-eval', state: 'fail', evalFolder: '/project/evals',
          failReason: 'wrong output',
          judgeVerdict: { result: 'fail', reasoning: 'Clear mismatch', confidence: 'medium' },
        },
      ];
      const summary = { total: 1, passed: 0, failed: 1, errors: 0 };

      const msg = composeFailureMessage(results, [], summary);

      expect(msg).not.toContain('Judge confidence was low');
    });

    it('shows check failures and notes judge was not invoked', () => {
      const results = [
        {
          evalName: 'check-only', state: 'fail', evalFolder: '/project/evals',
          checkFailures: [
            { type: 'regex_match', reason: 'Pattern not found' },
            { type: 'not_empty', reason: 'Evidence was empty' },
          ],
        },
      ];
      const summary = { total: 1, passed: 0, failed: 1, errors: 0 };

      const msg = composeFailureMessage(results, [], summary);

      expect(msg).toContain('Check failure: regex_match: Pattern not found; not_empty: Evidence was empty');
      expect(msg).toContain('Judge was not invoked — structural check failed');
    });

    it('handles history with unknown commit SHAs', () => {
      const results = [
        { evalName: 'my-eval', state: 'pass', evalFolder: '/project/evals' },
      ];
      const history = [
        { eval_name: 'my-eval', state: 'pass', commit_sha: null },
        { eval_name: 'my-eval', state: 'fail', commit_sha: 'abc123' },
      ];
      const summary = { total: 1, passed: 1, failed: 0, errors: 0 };

      const msg = composeFailureMessage(results, history, summary);

      expect(msg).toContain('FAIL abc123 → PASS ???');
    });

    it('flags low-confidence pass results in the message', () => {
      const results = [
        {
          evalName: 'ambiguous-eval', state: 'pass', evalFolder: '/project/evals',
          judgeVerdict: { result: 'pass', reasoning: 'Evidence is borderline', confidence: 'low' },
        },
        { evalName: 'solid-eval', state: 'pass', evalFolder: '/project/evals' },
      ];
      const summary = { total: 2, passed: 2, failed: 0, errors: 0 };

      const msg = composeFailureMessage(results, [], summary);

      expect(msg).toContain('PASSED (LOW CONFIDENCE): ambiguous-eval');
      expect(msg).toContain('LOW-CONFIDENCE PASSES');
      expect(msg).toContain('Evidence is borderline');
      expect(msg).toContain('verify before trusting this pass');
      // The solid eval should NOT be flagged
      expect(msg).toMatch(/PASSED: solid-eval/);
      expect(msg).not.toMatch(/PASSED \(LOW CONFIDENCE\): solid-eval/);
    });

    it('handles empty results gracefully', () => {
      const msg = composeFailureMessage([], [], { total: 0, passed: 0, failed: 0, errors: 0 });
      expect(msg).toContain('Eval run complete: 0 evals ran, 0 failed, 0 errors.');
    });

    it('truncates long evidence strings', () => {
      const longEvidence = 'x'.repeat(300);
      const results = [
        {
          evalName: 'long-evidence', state: 'fail', evalFolder: '/project/evals',
          failReason: 'mismatch',
          evidence: longEvidence,
        },
      ];
      const summary = { total: 1, passed: 0, failed: 1, errors: 0 };

      const msg = composeFailureMessage(results, [], summary);

      expect(msg).toContain('...');
      // Should be truncated, not full 300 chars
      const evidenceLine = msg.split('\n').find(l => l.includes('Evidence:'));
      expect(evidenceLine.length).toBeLessThan(250);
    });
  });
});
