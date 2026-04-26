import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://stub:stub@stub.invalid/stub';

const rollup = await import('../contextDocRollup.js');

describe('contextDocRollup', () => {
  let chat;

  beforeEach(() => {
    chat = vi.fn();
    rollup._setChatCompletionForTests(chat);
  });

  afterEach(() => {
    rollup._resetForTests();
  });

  describe('chunkExtractions', () => {
    it('splits into batches of 25', () => {
      const items = Array.from({ length: 60 }, (_, i) => i);
      const chunks = rollup.chunkExtractions(items);
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(25);
      expect(chunks[1]).toHaveLength(25);
      expect(chunks[2]).toHaveLength(10);
    });

    it('returns a single chunk for small inputs', () => {
      const chunks = rollup.chunkExtractions([1, 2, 3]);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual([1, 2, 3]);
    });

    it('returns no chunks for empty input', () => {
      expect(rollup.chunkExtractions([])).toEqual([]);
    });
  });

  describe('formatExtractionForPrompt', () => {
    it('omits empty sections', () => {
      const out = rollup.formatExtractionForPrompt({
        pr_number: 5,
        pr_title: 'Foo',
        pr_merged_at: '2026-01-01',
        extraction: { what_changed: 'x', why: '', product_decisions: [], architectural_decisions: [] },
      });
      expect(out).toContain('PR #5: Foo');
      expect(out).toContain('What changed: x');
      expect(out).not.toContain('Why:');
      expect(out).not.toContain('Product decisions:');
    });

    it('flags mechanical PRs', () => {
      const out = rollup.formatExtractionForPrompt({
        pr_number: 3,
        pr_title: 'Bump deps',
        extraction: { is_mechanical: true, what_changed: 'dep bump', files_touched: [] },
      });
      expect(out).toContain('Mechanical: yes');
    });
  });

  describe('rollupBatch', () => {
    it('passes batch metadata into the user prompt', async () => {
      chat.mockResolvedValue('# Batch Roll-up\n...');
      const out = await rollup.rollupBatch('myproj', 0, 2, [{ pr_number: 1, pr_title: 't', extraction: {} }]);
      expect(out).toContain('# Batch Roll-up');
      const userMsg = chat.mock.calls[0][0].messages[0].content;
      expect(userMsg).toContain('Batch: 1 of 2');
      expect(userMsg).toContain('Project: myproj');
      expect(userMsg).toContain('PR #1');
    });
  });

  describe('rollupFinal', () => {
    it('parses well-formed JSON output', async () => {
      chat.mockResolvedValue(JSON.stringify({
        product: '# Product\n...',
        architecture: '# Architecture\n...',
      }));
      const out = await rollup.rollupFinal('myproj', ['batch1'], 5);
      expect(out.product).toContain('# Product');
      expect(out.architecture).toContain('# Architecture');
    });

    it('parses output wrapped in a markdown fence', async () => {
      chat.mockResolvedValue('```json\n{"product":"P","architecture":"A"}\n```');
      const out = await rollup.rollupFinal('x', ['b'], 1);
      expect(out.product).toBe('P');
      expect(out.architecture).toBe('A');
    });

    it('throws when JSON is missing required fields', async () => {
      chat.mockResolvedValue('I cannot do that');
      await expect(rollup.rollupFinal('x', ['b'], 1)).rejects.toThrow(/valid JSON/);
    });
  });
});
