import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGatherEvidence = vi.fn();
const mockRunAllChecks = vi.fn();
const mockCallJudge = vi.fn();

vi.mock('../services/evidenceGatherers.js', () => ({
  gatherEvidence: mockGatherEvidence,
  interpolateVariables: (str) => str, // pass-through for tests
  default: { gatherEvidence: mockGatherEvidence, interpolateVariables: (str) => str },
}));

vi.mock('../services/evalChecks.js', () => ({
  runAllChecks: mockRunAllChecks,
  default: { runAllChecks: mockRunAllChecks },
}));

vi.mock('../services/evalJudge.js', () => ({
  callJudge: mockCallJudge,
  default: { callJudge: mockCallJudge },
}));

describe('evalRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function getModule() {
    return await import('../services/evalRunner.js');
  }

  const baseEval = {
    name: 'test-eval',
    description: 'A test eval',
    evidence: { type: 'log_query', source: 'session' },
  };

  const context = { sessionLogPath: '/logs/session.log' };

  describe('runSingleEval', () => {
    it('returns error state when evidence gathering fails', async () => {
      mockGatherEvidence.mockRejectedValue(new Error('File not found'));
      const { runSingleEval } = await getModule();

      const result = await runSingleEval(
        { ...baseEval, checks: [{ type: 'not_empty' }] },
        context
      );

      expect(result.state).toBe('error');
      expect(result.error).toContain('Evidence gathering failed');
      expect(result.evalName).toBe('test-eval');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('returns fail state when evidence is empty and allow_empty is false', async () => {
      mockGatherEvidence.mockResolvedValue('');
      const { runSingleEval } = await getModule();

      const result = await runSingleEval(
        { ...baseEval, checks: [{ type: 'not_empty' }] },
        context
      );

      expect(result.state).toBe('fail');
      expect(result.failReason).toBe('no evidence gathered');
    });

    it('continues when evidence is empty but allow_empty is true', async () => {
      mockGatherEvidence.mockResolvedValue('');
      mockRunAllChecks.mockReturnValue({ allPassed: true, results: [], failures: [] });
      const { runSingleEval } = await getModule();

      const result = await runSingleEval(
        { ...baseEval, evidence: { ...baseEval.evidence, allow_empty: true }, checks: [{ type: 'json_valid' }] },
        context
      );

      // Checks still run — but the eval doesn't bail early due to empty evidence
      expect(result.state).not.toBe(null);
    });

    it('returns fail state when checks fail', async () => {
      mockGatherEvidence.mockResolvedValue('some evidence');
      mockRunAllChecks.mockReturnValue({
        allPassed: false,
        results: [
          { type: 'regex_match', passed: false, reason: 'Pattern not found' },
        ],
        failures: [
          { type: 'regex_match', passed: false, reason: 'Pattern not found' },
        ],
      });
      const { runSingleEval } = await getModule();

      const result = await runSingleEval(
        { ...baseEval, checks: [{ type: 'regex_match', pattern: 'xyz' }] },
        context
      );

      expect(result.state).toBe('fail');
      expect(result.failReason).toContain('regex_match');
      expect(result.checkFailures).toHaveLength(1);
    });

    it('returns pass state for deterministic eval with passing checks and no judge', async () => {
      mockGatherEvidence.mockResolvedValue('valid evidence');
      mockRunAllChecks.mockReturnValue({
        allPassed: true,
        results: [{ type: 'not_empty', passed: true, reason: 'Non-empty' }],
        failures: [],
      });
      const { runSingleEval } = await getModule();

      const result = await runSingleEval(
        { ...baseEval, checks: [{ type: 'not_empty' }] },
        context
      );

      expect(result.state).toBe('pass');
      expect(result.judgeVerdict).toBeNull();
    });

    it('calls judge when judge_prompt is present and checks pass', async () => {
      mockGatherEvidence.mockResolvedValue('build succeeded');
      mockRunAllChecks.mockReturnValue({ allPassed: true, results: [], failures: [] });
      mockCallJudge.mockResolvedValue({
        result: 'pass',
        confidence: 'high',
        reasoning: 'Evidence shows "build succeeded".',
      });
      const { runSingleEval } = await getModule();

      const result = await runSingleEval(
        {
          ...baseEval,
          checks: [{ type: 'not_empty' }],
          judge_prompt: 'Did the build succeed?',
          expected: 'Build completes successfully',
        },
        context
      );

      expect(result.state).toBe('pass');
      expect(result.judgeVerdict.confidence).toBe('high');
      expect(mockCallJudge).toHaveBeenCalledWith(
        expect.objectContaining({
          expected: 'Build completes successfully',
          evidence: 'build succeeded',
          judgePrompt: 'Did the build succeed?',
        })
      );
    });

    it('returns fail state when judge says fail', async () => {
      mockGatherEvidence.mockResolvedValue('error in output');
      mockCallJudge.mockResolvedValue({
        result: 'fail',
        confidence: 'medium',
        reasoning: 'Evidence shows "error".',
      });
      const { runSingleEval } = await getModule();

      const result = await runSingleEval(
        {
          ...baseEval,
          judge_prompt: 'Did it pass?',
          expected: 'No errors',
        },
        context
      );

      expect(result.state).toBe('fail');
      expect(result.judgeVerdict.result).toBe('fail');
    });

    it('returns error state when judge parse fails', async () => {
      mockGatherEvidence.mockResolvedValue('some evidence');
      mockCallJudge.mockResolvedValue({
        result: null,
        error: 'No JSON found in response',
        rawResponse: 'garbage',
      });
      const { runSingleEval } = await getModule();

      const result = await runSingleEval(
        {
          ...baseEval,
          judge_prompt: 'Evaluate this',
          expected: 'Something good',
        },
        context
      );

      expect(result.state).toBe('error');
      expect(result.error).toContain('No JSON found');
    });

    it('includes timestamp and duration in result', async () => {
      mockGatherEvidence.mockResolvedValue('evidence');
      mockRunAllChecks.mockReturnValue({ allPassed: true, results: [], failures: [] });
      const { runSingleEval } = await getModule();

      const result = await runSingleEval(
        { ...baseEval, checks: [{ type: 'not_empty' }] },
        context
      );

      expect(result.timestamp).toBeDefined();
      expect(typeof result.duration).toBe('number');
    });
  });

  describe('runEvalBatch', () => {
    it('runs multiple evals in parallel and returns all results', async () => {
      mockGatherEvidence.mockResolvedValue('evidence');
      mockRunAllChecks.mockReturnValue({ allPassed: true, results: [], failures: [] });
      const { runEvalBatch } = await getModule();

      const evals = [
        { ...baseEval, name: 'eval-1', checks: [{ type: 'not_empty' }] },
        { ...baseEval, name: 'eval-2', checks: [{ type: 'not_empty' }] },
        { ...baseEval, name: 'eval-3', checks: [{ type: 'not_empty' }] },
      ];

      const results = await runEvalBatch(evals, context);

      expect(results).toHaveLength(3);
      expect(results[0].evalName).toBe('eval-1');
      expect(results[1].evalName).toBe('eval-2');
      expect(results[2].evalName).toBe('eval-3');
      expect(results.every((r) => r.state === 'pass')).toBe(true);
    });

    it('handles mixed results in batch', async () => {
      let callCount = 0;
      mockGatherEvidence.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error('Failed');
        return 'evidence';
      });
      mockRunAllChecks.mockReturnValue({ allPassed: true, results: [], failures: [] });
      const { runEvalBatch } = await getModule();

      const evals = [
        { ...baseEval, name: 'eval-pass', checks: [{ type: 'not_empty' }] },
        { ...baseEval, name: 'eval-error', checks: [{ type: 'not_empty' }] },
        { ...baseEval, name: 'eval-pass-2', checks: [{ type: 'not_empty' }] },
      ];

      const results = await runEvalBatch(evals, context);

      expect(results).toHaveLength(3);
      expect(results[0].state).toBe('pass');
      expect(results[1].state).toBe('error');
      expect(results[2].state).toBe('pass');
    });
  });
});
