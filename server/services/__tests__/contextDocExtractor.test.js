import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://stub:stub@stub.invalid/stub';

const extractor = await import('../contextDocExtractor.js');

describe('contextDocExtractor', () => {
  let chat;

  beforeEach(() => {
    chat = vi.fn();
    extractor._setChatCompletionForTests(chat);
  });

  afterEach(() => {
    extractor._resetForTests();
  });

  describe('parseExtractionJson', () => {
    it('parses raw JSON', () => {
      const out = extractor.parseExtractionJson('{"what_changed": "x"}');
      expect(out).toEqual({ what_changed: 'x' });
    });

    it('strips a markdown fence', () => {
      const text = '```json\n{"what_changed": "y"}\n```';
      const out = extractor.parseExtractionJson(text);
      expect(out).toEqual({ what_changed: 'y' });
    });

    it('finds the JSON object inside trailing prose', () => {
      const text = 'Here is the result:\n{"what_changed": "z"}\nthank you';
      const out = extractor.parseExtractionJson(text);
      expect(out).toEqual({ what_changed: 'z' });
    });

    it('returns null for unparseable input', () => {
      expect(extractor.parseExtractionJson('not json')).toBeNull();
      expect(extractor.parseExtractionJson('{not valid}')).toBeNull();
    });
  });

  describe('normalizeExtraction', () => {
    it('coerces missing fields to safe defaults', () => {
      const out = extractor.normalizeExtraction({});
      expect(out.what_changed).toBe('');
      expect(out.product_decisions).toEqual([]);
      expect(out.supersedes).toEqual([]);
      expect(out.is_mechanical).toBe(false);
      expect(out.files_touched).toEqual([]);
    });

    it('preserves supersedes bullets when present', () => {
      const out = extractor.normalizeExtraction({
        supersedes: ['Removes the X feature added in #5', '  Replaces the Y approach  '],
      });
      expect(out.supersedes).toEqual([
        'Removes the X feature added in #5',
        'Replaces the Y approach',
      ]);
    });

    it('caps files_touched at 25 entries', () => {
      const files = Array.from({ length: 40 }, (_, i) => `f${i}.js`);
      const out = extractor.normalizeExtraction({ files_touched: files });
      expect(out.files_touched).toHaveLength(25);
    });

    it('drops non-string array entries', () => {
      const out = extractor.normalizeExtraction({
        product_decisions: ['ok', 123, null, '  trimmed  '],
      });
      expect(out.product_decisions).toEqual(['ok', 'trimmed']);
    });
  });

  describe('extractPullRequest', () => {
    it('returns a normalized extraction when the LLM returns clean JSON', async () => {
      chat.mockResolvedValue(JSON.stringify({
        what_changed: 'Added X',
        why: 'Because Y',
        product_decisions: ['p1'],
        architectural_decisions: ['a1'],
        patterns_established: [],
        patterns_broken: [],
        files_touched: ['foo.js'],
        is_mechanical: false,
      }));

      const result = await extractor.extractPullRequest({
        number: 7, title: 't', body: 'b', diff: 'd',
      });

      expect(chat).toHaveBeenCalledTimes(1);
      const call = chat.mock.calls[0][0];
      expect(call.model).toBe(extractor.EXTRACTION_MODEL);
      expect(call.system).toBe(extractor.SYSTEM_PROMPT);
      expect(result.extraction.what_changed).toBe('Added X');
      expect(result.extraction.product_decisions).toEqual(['p1']);
    });

    it('falls back to a placeholder extraction when JSON parsing fails', async () => {
      chat.mockResolvedValue('I cannot do that.');
      const result = await extractor.extractPullRequest({
        number: 8, title: 't', body: '', diff: '',
      });
      expect(result.extraction.what_changed).toMatch(/extraction failed/);
      expect(result.raw).toBe('I cannot do that.');
    });

    it('forwards an abort signal to the gateway', async () => {
      const controller = new AbortController();
      chat.mockResolvedValue('{}');
      await extractor.extractPullRequest(
        { number: 1, title: 't', body: '', diff: '' },
        { signal: controller.signal },
      );
      expect(chat.mock.calls[0][0].signal).toBe(controller.signal);
    });
  });
});
