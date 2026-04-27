import { describe, it, expect, vi } from 'vitest';
import { buildSystemPrompt, sendChatTurn, draftFinalAnswer } from '../decisionChat.js';

const fakeQuestion = {
  id: 'q1',
  project_id: 'p1',
  question: 'Should we use Stripe or LemonSqueezy?',
  escalation_context: 'Project does not yet have a payments doc.',
  escalation_recommendation: 'Stripe — wider support.',
  escalation_reason: 'Cost-impact decision.',
  working_files: ['server/payments.js'],
};

const fakeProjectDocs = {
  productMd: '# Product\n...overview...',
  architectureMd: '# Architecture\n...overview...',
  decisionsMd: '## 2026-01-01 — chose Postgres',
};

describe('buildSystemPrompt', () => {
  it('includes the question, recommendation, and project doc snippets', () => {
    const prompt = buildSystemPrompt(fakeQuestion, fakeProjectDocs);
    expect(prompt).toContain('Stripe or LemonSqueezy');
    expect(prompt).toContain('wider support');
    expect(prompt).toContain('# Product');
    expect(prompt).toContain('# Architecture');
    expect(prompt).toContain('chose Postgres');
  });

  it('truncates very long doc content', () => {
    const huge = 'x'.repeat(50000);
    const prompt = buildSystemPrompt(fakeQuestion, { productMd: huge, architectureMd: '', decisionsMd: '' });
    expect(prompt.length).toBeLessThan(60000);
  });
});

describe('sendChatTurn', () => {
  it('calls llmGateway.chatCompletion with the right shape', async () => {
    const llmGateway = { chatCompletion: vi.fn().mockResolvedValue('Sure, let me think about that.') };
    const result = await sendChatTurn({
      llmGateway,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Why Stripe?' }],
    });
    expect(result).toBe('Sure, let me think about that.');
    expect(llmGateway.chatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      system: 'sys',
      messages: [{ role: 'user', content: 'Why Stripe?' }],
      model: expect.any(String),
      max_tokens: expect.any(Number),
    }));
  });
});

describe('draftFinalAnswer', () => {
  it('parses answer and reasoning from LLM response', async () => {
    const llmGateway = {
      chatCompletion: vi.fn().mockResolvedValue(`We should use Stripe because it has better integrations.

REASONING: Stripe is the market standard with the widest ecosystem.`),
    };
    const result = await draftFinalAnswer({
      llmGateway,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Which payment processor?' }],
    });
    expect(result.answer).toBe('We should use Stripe because it has better integrations.');
    expect(result.reasoning_summary).toContain('Stripe is the market standard');
  });

  it('returns empty reasoning if REASONING: line is missing', async () => {
    const llmGateway = {
      chatCompletion: vi.fn().mockResolvedValue('Just use Stripe.'),
    };
    const result = await draftFinalAnswer({
      llmGateway,
      systemPrompt: 'sys',
      messages: [],
    });
    expect(result.answer).toBe('Just use Stripe.');
    expect(result.reasoning_summary).toBe('');
  });
});
