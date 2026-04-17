import { describe, it, expect, beforeEach } from 'vitest';
import { resolvePrompt, registerField, _clearRegistryForTests } from '../services/mergeFields.js';

describe('resolvePrompt contract (consumed by sessionManager sendMessage and resumeSession)', () => {
  beforeEach(() => {
    _clearRegistryForTests();
    registerField('fake_pr', { description: 't', resolve: async () => '99' });
  });

  it('returns resolved text without mutating the caller\'s original string (callers rely on this to keep broadcast/DB text literal)', async () => {
    const userText = 'Run /ultrareview {{fake_pr}}';
    const { text: resolvedPrompt } = await resolvePrompt(userText, { workingDirectory: '/tmp' });
    expect(resolvedPrompt).toBe('Run /ultrareview 99');
    expect(userText).toBe('Run /ultrareview {{fake_pr}}');
  });

  it('leaves unresolved placeholders in-place with a soft note, so session callers can log-and-continue instead of failing', async () => {
    _clearRegistryForTests();
    registerField('known', { description: 'k', resolve: async () => null });
    const { text } = await resolvePrompt('x={{known}} y={{unknown}}', {});
    expect(text).toContain('{{known}}');
    expect(text).toContain('{{unknown}}');
    expect(text).toContain('(note:');
  });
});
