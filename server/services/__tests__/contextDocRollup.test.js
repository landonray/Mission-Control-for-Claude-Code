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

    it('includes supersedes section when present', () => {
      const out = rollup.formatExtractionForPrompt({
        pr_number: 9,
        pr_title: 'Refactor',
        extraction: {
          what_changed: 'rewrote thing',
          supersedes: ['Removes the legacy thing approach from #3'],
        },
      });
      expect(out).toContain('Supersedes (overrides earlier work):');
      expect(out).toContain('Removes the legacy thing approach from #3');
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
    const wellFormed = [
      '===BEGIN PRODUCT.md===',
      '# Product',
      'Body line one.',
      '===END PRODUCT.md===',
      '',
      '===BEGIN ARCHITECTURE.md===',
      '# Architecture',
      'Arch body.',
      '===END ARCHITECTURE.md===',
    ].join('\n');

    it('parses well-formed delimited output', async () => {
      chat.mockResolvedValue(wellFormed);
      const out = await rollup.rollupFinal('myproj', ['batch1'], 5);
      expect(out.product).toBe('# Product\nBody line one.');
      expect(out.architecture).toBe('# Architecture\nArch body.');
    });

    it('tolerates leading/trailing chatter from the model', async () => {
      chat.mockResolvedValue(`Sure, here you go:\n\n${wellFormed}\n\nThanks!`);
      const out = await rollup.rollupFinal('myproj', ['batch1'], 5);
      expect(out.product).toBe('# Product\nBody line one.');
      expect(out.architecture).toBe('# Architecture\nArch body.');
    });

    it('renders date ranges per batch when batchSummaries include them', async () => {
      chat.mockResolvedValue(wellFormed);
      await rollup.rollupFinal('myproj', [
        { output: 'first', dateRange: { start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' } },
        { output: 'second', dateRange: { start: '2026-02-15', end: '2026-03-30' } },
      ], 50);
      const userMsg = chat.mock.calls[0][0].messages[0].content;
      expect(userMsg).toContain('Batch 1 roll-up (PRs merged 2026-01-01 to 2026-02-01)');
      expect(userMsg).toContain('Batch 2 roll-up (PRs merged 2026-02-15 to 2026-03-30)');
      expect(userMsg).toContain('first');
      expect(userMsg).toContain('second');
    });

    it('still works when batchSummaries are plain strings (legacy)', async () => {
      chat.mockResolvedValue(wellFormed);
      await rollup.rollupFinal('myproj', ['only-batch'], 1);
      const userMsg = chat.mock.calls[0][0].messages[0].content;
      expect(userMsg).toContain('Batch 1 roll-up\n');
      expect(userMsg).toContain('only-batch');
    });

    it('throws when output is missing the architecture block (e.g., truncated)', async () => {
      const truncated = '===BEGIN PRODUCT.md===\n# Product\nstuff\n===END PRODUCT.md===\n===BEGIN ARCHITECTURE.md===\n# Architecture\nincomplete';
      chat.mockResolvedValue(truncated);
      await expect(rollup.rollupFinal('x', ['b'], 1)).rejects.toThrow(/expected delimiters/);
    });

    it('throws when output has no delimiters at all', async () => {
      chat.mockResolvedValue('I cannot do that');
      await expect(rollup.rollupFinal('x', ['b'], 1)).rejects.toThrow(/expected delimiters/);
    });
  });

  describe('parseFinalOutput', () => {
    it('returns null when product block is missing', () => {
      const text = '===BEGIN ARCHITECTURE.md===\nA\n===END ARCHITECTURE.md===';
      expect(rollup.parseFinalOutput(text)).toBeNull();
    });

    it('strips the leading and trailing newlines around the content', () => {
      const text = '===BEGIN PRODUCT.md===\n\nP\n\n===END PRODUCT.md===\n===BEGIN ARCHITECTURE.md===\nA\n===END ARCHITECTURE.md===';
      const out = rollup.parseFinalOutput(text);
      expect(out.product).toBe('\nP');
      expect(out.architecture).toBe('A');
    });
  });
});
