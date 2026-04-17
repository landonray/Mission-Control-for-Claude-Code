import { describe, it, expect, beforeEach } from 'vitest';
import { resolvePrompt, registerField, _clearRegistryForTests } from '../services/mergeFields.js';

describe('sendMessage merge-field resolution', () => {
  beforeEach(() => {
    _clearRegistryForTests();
    registerField('fake_pr', { description: 't', resolve: async () => '99' });
  });

  it('resolves merge fields in the prompt passed to spawnProcess but leaves broadcast text literal', async () => {
    const userText = 'Run /ultrareview {{fake_pr}}';
    const { text: resolvedPrompt } = await resolvePrompt(userText, { workingDirectory: '/tmp' });
    expect(resolvedPrompt).toBe('Run /ultrareview 99');
    expect(userText).toBe('Run /ultrareview {{fake_pr}}');
  });

  it('session constructor path still treats unresolved placeholders softly', async () => {
    _clearRegistryForTests();
    registerField('known', { description: 'k', resolve: async () => null });
    const { text } = await resolvePrompt('x={{known}} y={{unknown}}', {});
    expect(text).toContain('{{known}}');
    expect(text).toContain('{{unknown}}');
    expect(text).toContain('(note:');
  });
});
