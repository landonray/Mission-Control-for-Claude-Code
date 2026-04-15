/**
 * Eval Judge — calls an LLM to judge evidence against expected outcomes.
 */

import { chatCompletion } from './llmGateway.js';

export const MODEL_MAP = {
  default: 'claude-sonnet-4-6',
  fast: 'claude-haiku-4-5-20251001',
  strong: 'claude-opus-4-6',
};

export const JUDGE_SYSTEM_PROMPT = `You are an eval judge. Your job is to determine whether gathered evidence meets the expected outcome.

You MUST respond with a single JSON object (no markdown fences, no extra text) in this exact format:
{
  "result": "pass" or "fail",
  "confidence": "low", "medium", or "high",
  "reasoning": "A brief explanation. You MUST quote specific evidence to support your judgment."
}

Rules:
- "pass" means the evidence demonstrates the expected outcome was achieved.
- "fail" means the evidence does NOT demonstrate the expected outcome.
- Always quote specific parts of the evidence in your reasoning.
- If the evidence is ambiguous, lean toward "fail" with "low" confidence.
- Do NOT invent or assume evidence that was not provided.`;

/**
 * Call the LLM judge to evaluate evidence against expected outcome.
 * @param {object} opts
 * @param {string} opts.expected - Expected outcome description
 * @param {string} opts.evidence - Gathered evidence
 * @param {string} opts.judgePrompt - Additional instructions for the judge
 * @param {string} [opts.model] - Model key from MODEL_MAP (default, fast, strong)
 * @returns {Promise<{ result: string|null, confidence: string, reasoning: string, error?: string, rawResponse?: string }>}
 */
export async function callJudge({ expected, evidence, judgePrompt, model }) {
  const modelId = MODEL_MAP[model] || MODEL_MAP.default;

  const userMessage = [
    '## Expected Outcome',
    expected,
    '',
    '## Evidence',
    evidence || '(no evidence gathered)',
    '',
    '## Judging Criteria',
    judgePrompt || '(none)',
  ].join('\n');

  let raw;
  try {
    raw = await chatCompletion({
      model: modelId,
      max_tokens: 1024,
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
  } catch (err) {
    return {
      result: null,
      error: `LLM call failed: ${err.message}`,
      rawResponse: null,
    };
  }

  return parseJudgeResponse(raw);
}

/**
 * Parse the LLM judge response, handling markdown fences and malformed JSON.
 * @param {string} raw - Raw LLM response text
 * @returns {{ result: string|null, confidence?: string, reasoning?: string, error?: string, rawResponse?: string }}
 */
export function parseJudgeResponse(raw) {
  if (!raw || typeof raw !== 'string') {
    return { result: null, error: 'Empty response from judge', rawResponse: String(raw) };
  }

  // Strip markdown code fences if present
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
  cleaned = cleaned.replace(/\n?```\s*$/i, '');
  cleaned = cleaned.trim();

  // Try to extract the first JSON object
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { result: null, error: 'No JSON object found in judge response', rawResponse: raw };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return { result: null, error: `Failed to parse judge JSON: ${err.message}`, rawResponse: raw };
  }

  // Validate required fields
  if (!parsed.result || !['pass', 'fail'].includes(parsed.result)) {
    return {
      result: null,
      error: `Invalid judge result: "${parsed.result}" — must be "pass" or "fail"`,
      rawResponse: raw,
    };
  }

  if (!parsed.confidence || !['low', 'medium', 'high'].includes(parsed.confidence)) {
    return {
      result: null,
      error: `Invalid judge confidence: "${parsed.confidence}" — must be "low", "medium", or "high"`,
      rawResponse: raw,
    };
  }

  if (!parsed.reasoning || typeof parsed.reasoning !== 'string') {
    return {
      result: null,
      error: 'Judge response missing "reasoning" field',
      rawResponse: raw,
    };
  }

  return {
    result: parsed.result,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
  };
}
