import { describe, it, expect, vi } from 'vitest';

const runner = await import('../index.js');

describe('runAllVerifiers', () => {
  it('runs all registered verifiers in parallel and returns their results', async () => {
    const results = await runner.runAllVerifiers('/does/not/exist');
    // Three verifiers shipped today; each should degrade gracefully.
    expect(results).toHaveLength(runner.VERIFIERS.length);
    for (const r of results) {
      expect(r).toHaveProperty('category');
      expect(r).toHaveProperty('items');
      expect(Array.isArray(r.items)).toBe(true);
    }
    // All sources missing → all verifiers note the missing file.
    expect(results.every(r => r.items.length === 0)).toBe(true);
  });

  it('catches per-verifier errors and reports them in notes', async () => {
    const breaking = {
      SOURCE_REL_PATH: 'fake.js',
      extract: vi.fn().mockRejectedValue(new Error('boom')),
    };
    // Save original verifiers, swap in a broken one for the test.
    const original = [...runner.VERIFIERS];
    runner.VERIFIERS.length = 0;
    runner.VERIFIERS.push(breaking);
    try {
      const results = await runner.runAllVerifiers('/x');
      expect(results[0].notes).toMatch(/boom/);
      expect(results[0].items).toEqual([]);
    } finally {
      runner.VERIFIERS.length = 0;
      runner.VERIFIERS.push(...original);
    }
  });
});
