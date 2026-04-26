import { describe, it, expect } from 'vitest';
import { sanitizeAssistantText } from '../sanitizeAssistantText';

describe('sanitizeAssistantText (client)', () => {
  it('returns plain prose unchanged', () => {
    expect(sanitizeAssistantText('Hello world')).toBe('Hello world');
  });

  it('strips a sub-agent transcript and keeps only the prose', () => {
    const input = [
      '',
      '[Tool: bash]',
      '',
      'Tool result: # bash - status',
      '',
      'Last 1 lines (full output: 1 lines, 3 tokens):',
      'On branch foo',
      'Assistant: ',
      '[Tool: bash]',
      '',
      'Tool result: # bash - push',
      '',
      '(no output)',
      'Assistant: Pushed and done.'
    ].join('\n');
    expect(sanitizeAssistantText(input)).toBe('Pushed and done.');
  });

  it('returns null/undefined unchanged', () => {
    expect(sanitizeAssistantText(null)).toBe(null);
    expect(sanitizeAssistantText(undefined)).toBe(undefined);
  });

  it('does not strip prose that mentions [Tool: bash] in code spans', () => {
    const input = 'When an assistant message starts with `[Tool: bash]` we strip the transcript.';
    expect(sanitizeAssistantText(input)).toBe(input);
  });
});
