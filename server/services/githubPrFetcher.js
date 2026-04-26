/**
 * GitHub PR fetcher — pulls closed-and-merged PRs for a project's repo using
 * the `gh` CLI (the rest of the codebase relies on it too, so it inherits the
 * user's existing GitHub auth).
 *
 * Public surface:
 *   - listMergedPullRequests(githubRepo): returns ordered list of merged PR
 *     metadata (oldest first by merged_at).
 *   - fetchPullRequestDetails(githubRepo, number): returns the diff and other
 *     fields needed for extraction. Diffs over MAX_DIFF_BYTES are truncated.
 *
 * Test seam: _setGhExecutorForTests({ apiJson, apiText }) replaces the two
 * underlying invocations so unit tests don't shell out.
 */

'use strict';

const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const MAX_DIFF_BYTES = 50 * 1024; // 50KB cap; larger diffs get summarized into placeholders.
const PER_PAGE = 100;

// --- test seam ---------------------------------------------------------------

let _ghApiJson = defaultGhApiJson;
let _ghApiText = defaultGhApiText;

function _setGhExecutorForTests({ apiJson, apiText } = {}) {
  if (apiJson) _ghApiJson = apiJson;
  if (apiText) _ghApiText = apiText;
}

function _resetGhExecutorForTests() {
  _ghApiJson = defaultGhApiJson;
  _ghApiText = defaultGhApiText;
}

async function defaultGhApiJson(endpoint, args = []) {
  const { stdout } = await execFileAsync(
    'gh',
    ['api', endpoint, ...args],
    { maxBuffer: 50 * 1024 * 1024 }
  );
  return JSON.parse(stdout);
}

async function defaultGhApiText(endpoint, args = []) {
  const { stdout } = await execFileAsync(
    'gh',
    ['api', endpoint, ...args],
    { maxBuffer: 50 * 1024 * 1024 }
  );
  return stdout;
}

// --- public ------------------------------------------------------------------

function parseRepo(githubRepo) {
  if (!githubRepo || !/^[^/\s]+\/[^/\s]+$/.test(githubRepo)) {
    throw new Error(`Invalid github_repo "${githubRepo}" — expected "owner/repo"`);
  }
  const [owner, repo] = githubRepo.split('/');
  return { owner, repo };
}

async function listMergedPullRequests(githubRepo) {
  const { owner, repo } = parseRepo(githubRepo);
  const all = [];
  let page = 1;
  // Hard cap to avoid unbounded loops on misbehaving repos.
  while (page <= 50) {
    const endpoint = `repos/${owner}/${repo}/pulls?state=closed&per_page=${PER_PAGE}&page=${page}&sort=created&direction=asc`;
    const batch = await _ghApiJson(endpoint);
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const pr of batch) {
      if (!pr || !pr.merged_at) continue;
      all.push({
        number: pr.number,
        title: pr.title || '',
        body: pr.body || '',
        merged_at: pr.merged_at,
        url: pr.html_url,
      });
    }
    if (batch.length < PER_PAGE) break;
    page += 1;
  }
  // Order oldest → newest so rollup gets chronological context.
  all.sort((a, b) => new Date(a.merged_at) - new Date(b.merged_at));
  return all;
}

async function fetchPullRequestDetails(githubRepo, number) {
  const { owner, repo } = parseRepo(githubRepo);
  const diff = await _ghApiText(
    `repos/${owner}/${repo}/pulls/${number}`,
    ['-H', 'Accept: application/vnd.github.v3.diff']
  ).catch(err => {
    // Diff endpoint failures shouldn't kill the whole pipeline — extraction
    // can still run on title + body alone.
    return `[diff unavailable: ${err.message}]`;
  });

  return {
    number,
    diff: truncateDiff(diff),
    diff_truncated: typeof diff === 'string' && diff.length > MAX_DIFF_BYTES,
  };
}

function truncateDiff(text) {
  if (typeof text !== 'string') return '';
  if (text.length <= MAX_DIFF_BYTES) return text;
  const headSize = Math.floor(MAX_DIFF_BYTES * 0.6);
  const tailSize = MAX_DIFF_BYTES - headSize - 200;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  return `${head}\n\n[... diff truncated — original size ${text.length} bytes ...]\n\n${tail}`;
}

module.exports = {
  listMergedPullRequests,
  fetchPullRequestDetails,
  parseRepo,
  MAX_DIFF_BYTES,
  _setGhExecutorForTests,
  _resetGhExecutorForTests,
};
