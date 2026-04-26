import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.DATABASE_URL ||= 'postgres://stub:stub@stub.invalid/stub';

const fetcher = await import('../githubPrFetcher.js');

describe('githubPrFetcher', () => {
  let apiJson;
  let apiText;

  beforeEach(() => {
    apiJson = vi.fn();
    apiText = vi.fn();
    fetcher._setGhExecutorForTests({ apiJson, apiText });
  });

  afterEach(() => {
    fetcher._resetGhExecutorForTests();
  });

  describe('parseRepo', () => {
    it('accepts owner/repo format', () => {
      expect(fetcher.parseRepo('octocat/hello')).toEqual({ owner: 'octocat', repo: 'hello' });
    });

    it('rejects malformed input', () => {
      expect(() => fetcher.parseRepo('justname')).toThrow(/expected "owner\/repo"/);
      expect(() => fetcher.parseRepo('')).toThrow();
      expect(() => fetcher.parseRepo(null)).toThrow();
    });
  });

  describe('listMergedPullRequests', () => {
    it('returns merged PRs only, sorted by merged_at ascending', async () => {
      apiJson.mockResolvedValueOnce([
        { number: 1, title: 'A', body: 'a', merged_at: '2026-01-02T00:00:00Z', html_url: 'u1' },
        { number: 2, title: 'B', body: 'b', merged_at: null, html_url: 'u2' }, // closed but not merged — skipped
        { number: 3, title: 'C', body: 'c', merged_at: '2026-01-01T00:00:00Z', html_url: 'u3' },
      ]);

      const prs = await fetcher.listMergedPullRequests('octocat/hello');

      expect(prs).toHaveLength(2);
      expect(prs[0].number).toBe(3); // earlier merge first
      expect(prs[1].number).toBe(1);
      expect(prs.find(p => p.number === 2)).toBeUndefined();
    });

    it('paginates until an empty or short page is returned', async () => {
      // First page returns 100 entries (a full page), second returns empty.
      const fullPage = Array.from({ length: 100 }, (_, i) => ({
        number: i + 1, title: `PR ${i}`, body: '', merged_at: '2026-01-01T00:00:00Z', html_url: '',
      }));
      apiJson
        .mockResolvedValueOnce(fullPage)
        .mockResolvedValueOnce([]);

      const prs = await fetcher.listMergedPullRequests('octocat/hello');
      expect(prs).toHaveLength(100);
      expect(apiJson).toHaveBeenCalledTimes(2);
    });

    it('throws on invalid github_repo', async () => {
      await expect(fetcher.listMergedPullRequests('bad')).rejects.toThrow(/owner\/repo/);
    });
  });

  describe('fetchPullRequestDetails', () => {
    it('returns the diff text when small', async () => {
      apiText.mockResolvedValueOnce('diff --git a/foo b/foo\n@@\n+x');
      const out = await fetcher.fetchPullRequestDetails('octocat/hello', 42);
      expect(out.diff).toContain('diff --git');
      expect(out.diff_truncated).toBe(false);
    });

    it('truncates oversized diffs and marks them', async () => {
      const big = 'A'.repeat(fetcher.MAX_DIFF_BYTES + 1000);
      apiText.mockResolvedValueOnce(big);
      const out = await fetcher.fetchPullRequestDetails('octocat/hello', 1);
      expect(out.diff_truncated).toBe(true);
      expect(out.diff).toMatch(/\[\.\.\. diff truncated/);
      expect(out.diff.length).toBeLessThanOrEqual(fetcher.MAX_DIFF_BYTES + 200);
    });

    it('returns a placeholder when the diff fetch fails', async () => {
      apiText.mockRejectedValueOnce(new Error('network down'));
      const out = await fetcher.fetchPullRequestDetails('octocat/hello', 9);
      expect(out.diff).toMatch(/\[diff unavailable: network down\]/);
    });
  });
});
