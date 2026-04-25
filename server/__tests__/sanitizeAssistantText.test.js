import { describe, it, expect } from 'vitest';
import { sanitizeAssistantText } from '../utils/sanitizeAssistantText.js';

describe('sanitizeAssistantText', () => {
  it('returns plain prose unchanged', () => {
    expect(sanitizeAssistantText('Hello world')).toBe('Hello world');
  });

  it('returns empty/null inputs unchanged', () => {
    expect(sanitizeAssistantText('')).toBe('');
    expect(sanitizeAssistantText(null)).toBe(null);
    expect(sanitizeAssistantText(undefined)).toBe(undefined);
  });

  it('strips a single tool block followed by Assistant prose', () => {
    const input = [
      '[Tool: bash]',
      '',
      'Tool result: # bash - Show working tree status',
      '',
      'Last 2 lines (full output: 2 lines, 6 tokens):',
      'On branch main',
      'nothing to commit, working tree clean',
      'Assistant: Branch is clean.'
    ].join('\n');
    expect(sanitizeAssistantText(input)).toBe('Branch is clean.');
  });

  it('strips multiple alternating tool blocks and keeps interleaved prose', () => {
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
      'Tool result: # bash - log',
      '',
      'Last 1 lines (full output: 1 lines, 5 tokens):',
      'abc commit',
      'Assistant: Branch is ahead of remote. Pushing now.',
      '[Tool: bash]',
      '',
      'Tool result: # bash - push',
      '',
      '(no output)'
    ].join('\n');
    expect(sanitizeAssistantText(input)).toBe('Branch is ahead of remote. Pushing now.');
  });

  it('returns empty string when the entire content is a tool transcript with no prose', () => {
    const input = [
      '[Tool: bash]',
      '',
      'Tool result: # bash - status',
      '',
      'Last 2 lines (full output: 2 lines, 6 tokens):',
      'On branch main',
      'nothing to commit, working tree clean'
    ].join('\n');
    expect(sanitizeAssistantText(input)).toBe('');
  });

  it('does not touch text containing the literal string "[Tool" without the colon-name pattern', () => {
    const input = 'I added a new entry called "[Tool] Editor" to the menu.';
    expect(sanitizeAssistantText(input)).toBe(input);
  });

  it('does not strip prose that mentions "[Tool: bash]" inline (e.g. in markdown code spans)', () => {
    const input = 'The bug shows up when an assistant message starts with `[Tool: bash]` followed by output. We strip those.';
    expect(sanitizeAssistantText(input)).toBe(input);
  });

  it('does not strip when only "[Tool:" appears without a paired "Tool result:" line', () => {
    const input = 'See [Tool: bash] in the docs — but here is some other prose.';
    expect(sanitizeAssistantText(input)).toBe(input);
  });

  it('keeps prose that follows a transcript block when there is no "Assistant:" marker between them', () => {
    const input = [
      '[Tool: bash]',
      '',
      'Tool result: # bash - Open a pull request',
      '',
      'Last 4 lines (full output: 4 lines, 96 tokens):',
      'https://github.com/foo/pull/2',
      'remote://github.com/foo/pull/2',
      '',
      'The PR is up: https://github.com/foo/pull/2',
      '',
      'You said you would handle the merge — let me know when it is in.'
    ].join('\n');
    expect(sanitizeAssistantText(input)).toBe('You said you would handle the merge — let me know when it is in.');
  });

  it('preserves multi-line prose between tool blocks', () => {
    const input = [
      '[Tool: bash]',
      '',
      'Tool result: # bash - x',
      '',
      'Last 1 lines (full output: 1 lines, 1 tokens):',
      'output line 1',
      'Assistant: Line one of prose.',
      'Line two of prose.',
      '[Tool: bash]',
      '',
      'Tool result: # bash - y',
      '',
      'Last 1 lines (full output: 1 lines, 1 tokens):',
      'output line 2',
      'Assistant: Final line.'
    ].join('\n');
    expect(sanitizeAssistantText(input)).toBe('Line one of prose.\nLine two of prose.\nFinal line.');
  });

  it('handles "(no output)" tool blocks at the very end of the message', () => {
    const input = [
      'Pushing now.',
      '[Tool: bash]',
      '',
      'Tool result: # bash - Push branch to remote',
      '',
      '(no output)'
    ].join('\n');
    expect(sanitizeAssistantText(input)).toBe('Pushing now.');
  });
});
