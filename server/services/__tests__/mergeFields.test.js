import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePrompt, registerField, _clearRegistryForTests } from '../mergeFields.js';

describe('mergeFields', () => {
  beforeEach(() => {
    _clearRegistryForTests();
  });

  describe('resolvePrompt', () => {
    it('returns text unchanged when no placeholders are present', async () => {
      const result = await resolvePrompt('hello world', {});
      expect(result.text).toBe('hello world');
      expect(result.unresolved).toEqual([]);
    });

    it('substitutes a registered field with its resolved value', async () => {
      registerField('foo', { description: 'test', resolve: async () => '42' });
      const result = await resolvePrompt('answer is {{foo}}', {});
      expect(result.text).toBe('answer is 42');
      expect(result.unresolved).toEqual([]);
    });

    it('substitutes multiple fields', async () => {
      registerField('a', { description: 'a', resolve: async () => '1' });
      registerField('b', { description: 'b', resolve: async () => '2' });
      const result = await resolvePrompt('{{a}} and {{b}}', {});
      expect(result.text).toBe('1 and 2');
    });

    it('leaves placeholder literal and records unresolved when resolver returns null', async () => {
      registerField('missing', { description: 'm', resolve: async () => null });
      const result = await resolvePrompt('pr={{missing}}', {});
      expect(result.text).toContain('{{missing}}');
      expect(result.text).toContain('(note: merge field {{missing}} could not be resolved');
      expect(result.unresolved).toEqual([{ name: 'missing', reason: 'no value' }]);
    });

    it('leaves placeholder literal when resolver throws', async () => {
      registerField('broken', { description: 'x', resolve: async () => { throw new Error('boom'); } });
      const result = await resolvePrompt('x={{broken}}', {});
      expect(result.text).toContain('{{broken}}');
      expect(result.text).toContain('could not be resolved — boom');
      expect(result.unresolved[0].reason).toBe('boom');
    });

    it('treats unknown field names as unresolved', async () => {
      const result = await resolvePrompt('hi {{nope}}', {});
      expect(result.text).toContain('{{nope}}');
      expect(result.unresolved[0].reason).toBe('unknown field');
    });

    it('only prepends a single note block even with multiple unresolved fields', async () => {
      const result = await resolvePrompt('a {{x}} b {{y}}', {});
      const noteCount = (result.text.match(/\(note:/g) || []).length;
      expect(noteCount).toBe(1);
      expect(result.text).toContain('{{x}}');
      expect(result.text).toContain('{{y}}');
    });
  });

  describe('listFields', () => {
    it('returns registered field names and descriptions', async () => {
      const { listFields } = await import('../mergeFields.js');
      registerField('last_pr', { description: 'most recently updated open PR number', resolve: async () => null });
      const fields = listFields();
      expect(fields).toEqual([{ name: 'last_pr', description: 'most recently updated open PR number' }]);
    });
  });
});
