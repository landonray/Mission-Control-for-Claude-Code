import { describe, it, expect, beforeEach } from 'vitest';
import { resolvePrompt, registerField, _clearRegistryForTests } from '../services/mergeFields.js';

describe('qualityRunner merge-field contract', () => {
  beforeEach(() => {
    _clearRegistryForTests();
    registerField('fake_pr', { description: 't', resolve: async () => '42' });
  });

  it('a quality rule prompt containing {{fake_pr}} resolves before reaching the CLI', async () => {
    const rulePrompt = 'Check PR #{{fake_pr}} for quality issues.';
    const { text } = await resolvePrompt(rulePrompt, { workingDirectory: '/tmp' });
    expect(text).toBe('Check PR #42 for quality issues.');
  });

  it('unresolved merge fields in rule prompt survive as literal with note', async () => {
    const rulePrompt = 'Check PR #{{unknown_field}} for issues.';
    const { text, unresolved } = await resolvePrompt(rulePrompt, { workingDirectory: '/tmp' });
    expect(text).toContain('{{unknown_field}}');
    expect(text).toContain('(note:');
    expect(unresolved[0].reason).toBe('unknown field');
  });
});
