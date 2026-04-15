import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChatCompletion = vi.fn();

vi.mock('../services/llmGateway.js', () => ({
  chatCompletion: mockChatCompletion,
  default: { chatCompletion: mockChatCompletion },
}));

describe('evalJudge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function getModule() {
    return await import('../services/evalJudge.js');
  }

  describe('callJudge', () => {
    it('calls chatCompletion with correct params and returns parsed result', async () => {
      mockChatCompletion.mockResolvedValue(
        '{"result": "pass", "confidence": "high", "reasoning": "The evidence shows \\"success\\" in the output."}'
      );
      const { callJudge, MODEL_MAP } = await getModule();

      const result = await callJudge({
        expected: 'Build succeeds',
        evidence: 'Build completed: success',
        judgePrompt: 'Check for success message',
      });

      expect(result.result).toBe('pass');
      expect(result.confidence).toBe('high');
      expect(result.reasoning).toContain('success');
      expect(mockChatCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          model: MODEL_MAP.default,
          max_tokens: 1024,
        })
      );
    });

    it('uses fast model when specified', async () => {
      mockChatCompletion.mockResolvedValue(
        '{"result": "fail", "confidence": "medium", "reasoning": "No evidence of success."}'
      );
      const { callJudge, MODEL_MAP } = await getModule();

      await callJudge({
        expected: 'Tests pass',
        evidence: 'Error: 3 tests failed',
        model: 'fast',
      });

      expect(mockChatCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ model: MODEL_MAP.fast })
      );
    });

    it('returns error when LLM call fails', async () => {
      mockChatCompletion.mockRejectedValue(new Error('Gateway timeout'));
      const { callJudge } = await getModule();

      const result = await callJudge({
        expected: 'Test',
        evidence: 'Test',
      });

      expect(result.result).toBeNull();
      expect(result.error).toContain('LLM call failed');
    });
  });

  describe('parseJudgeResponse', () => {
    it('parses valid JSON response', async () => {
      const { parseJudgeResponse } = await getModule();
      const result = parseJudgeResponse(
        '{"result": "pass", "confidence": "high", "reasoning": "Evidence shows success."}'
      );

      expect(result.result).toBe('pass');
      expect(result.confidence).toBe('high');
      expect(result.reasoning).toBe('Evidence shows success.');
    });

    it('strips markdown code fences', async () => {
      const { parseJudgeResponse } = await getModule();
      const result = parseJudgeResponse(
        '```json\n{"result": "fail", "confidence": "low", "reasoning": "No evidence."}\n```'
      );

      expect(result.result).toBe('fail');
      expect(result.confidence).toBe('low');
    });

    it('extracts JSON from surrounding text', async () => {
      const { parseJudgeResponse } = await getModule();
      const result = parseJudgeResponse(
        'Here is my analysis:\n{"result": "pass", "confidence": "medium", "reasoning": "Looks good."}\nEnd.'
      );

      expect(result.result).toBe('pass');
    });

    it('returns error for empty response', async () => {
      const { parseJudgeResponse } = await getModule();
      const result = parseJudgeResponse('');
      expect(result.result).toBeNull();
      expect(result.error).toContain('Empty response');
    });

    it('returns error for no JSON found', async () => {
      const { parseJudgeResponse } = await getModule();
      const result = parseJudgeResponse('Just some plain text without JSON');
      expect(result.result).toBeNull();
      expect(result.error).toContain('No JSON object found');
      expect(result.rawResponse).toBe('Just some plain text without JSON');
    });

    it('returns error for invalid JSON', async () => {
      const { parseJudgeResponse } = await getModule();
      const result = parseJudgeResponse('{broken json here}');
      expect(result.result).toBeNull();
      expect(result.error).toContain('Failed to parse');
    });

    it('returns error for invalid result value', async () => {
      const { parseJudgeResponse } = await getModule();
      const result = parseJudgeResponse(
        '{"result": "maybe", "confidence": "high", "reasoning": "Unsure."}'
      );
      expect(result.result).toBeNull();
      expect(result.error).toContain('Invalid judge result');
    });

    it('returns error for invalid confidence value', async () => {
      const { parseJudgeResponse } = await getModule();
      const result = parseJudgeResponse(
        '{"result": "pass", "confidence": "very_high", "reasoning": "Great."}'
      );
      expect(result.result).toBeNull();
      expect(result.error).toContain('Invalid judge confidence');
    });

    it('returns error for missing reasoning', async () => {
      const { parseJudgeResponse } = await getModule();
      const result = parseJudgeResponse(
        '{"result": "pass", "confidence": "high"}'
      );
      expect(result.result).toBeNull();
      expect(result.error).toContain('missing "reasoning"');
    });
  });

  describe('exports', () => {
    it('exports MODEL_MAP with expected keys', async () => {
      const { MODEL_MAP } = await getModule();
      expect(MODEL_MAP.default).toBeDefined();
      expect(MODEL_MAP.fast).toBeDefined();
      expect(MODEL_MAP.strong).toBeDefined();
    });

    it('exports JUDGE_SYSTEM_PROMPT', async () => {
      const { JUDGE_SYSTEM_PROMPT } = await getModule();
      expect(JUDGE_SYSTEM_PROMPT).toContain('evaluation judge');
      expect(JUDGE_SYSTEM_PROMPT).toContain('pass');
      expect(JUDGE_SYSTEM_PROMPT).toContain('fail');
    });
  });
});
