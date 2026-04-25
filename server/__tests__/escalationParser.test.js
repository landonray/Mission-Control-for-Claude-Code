import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseEscalation } = require('../services/escalationParser');

describe('parseEscalation', () => {
  it('returns null for normal answers', () => {
    expect(parseEscalation('Sure, you should use Postgres.')).toBeNull();
    expect(parseEscalation('')).toBeNull();
    expect(parseEscalation(null)).toBeNull();
  });

  it('parses a well-formed ESCALATE block', () => {
    const text = `ESCALATE
Question: Should we switch from REST to GraphQL?
Context: PRODUCT.md does not mention API style. ARCHITECTURE.md uses Express + REST.
Recommendation: Stay on REST for now — the team has REST expertise and no consumers are blocked.
Reason for escalation: Strategic / business direction.`;
    const result = parseEscalation(text);
    expect(result).toEqual({
      question: 'Should we switch from REST to GraphQL?',
      context: 'PRODUCT.md does not mention API style. ARCHITECTURE.md uses Express + REST.',
      recommendation: 'Stay on REST for now — the team has REST expertise and no consumers are blocked.',
      reason: 'Strategic / business direction.',
    });
  });

  it('parses ESCALATE with multi-line fields', () => {
    const text = `ESCALATE
Question: Should we drop SQLite support?

It's been deprecated for two releases.
Context: Two customers are still on it.

We don't have migration tooling.
Recommendation: Keep it for one more release.
Reason for escalation: External stakeholder implications.`;
    const result = parseEscalation(text);
    expect(result.question).toContain("It's been deprecated for two releases.");
    expect(result.context).toContain("We don't have migration tooling.");
    expect(result.recommendation).toBe('Keep it for one more release.');
    expect(result.reason).toBe('External stakeholder implications.');
  });

  it('tolerates leading whitespace/prose before ESCALATE', () => {
    const text = `Some thinking out loud here.\n\nESCALATE\nQuestion: X\nContext: Y\nRecommendation: Z\nReason for escalation: W`;
    const result = parseEscalation(text);
    expect(result).not.toBeNull();
    expect(result.question).toBe('X');
  });

  it('returns null if format is malformed (missing fields)', () => {
    const text = `ESCALATE\nQuestion: Only a question.\nReason for escalation: missing recommendation`;
    expect(parseEscalation(text)).toBeNull();
  });

  it('returns null when ESCALATE appears mid-line in prose', () => {
    const text = 'I would say ESCALATE this issue, but actually the answer is X.';
    expect(parseEscalation(text)).toBeNull();
  });
});
