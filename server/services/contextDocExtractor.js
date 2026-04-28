/**
 * Per-PR extraction layer for the context document pipeline.
 *
 * Takes a single PR's content (title, body, diff) and asks Sonnet to extract
 * a structured summary: what changed, why, product decisions, architectural
 * decisions, patterns. Returns a plain object that's ready to JSON-stringify
 * into the context_doc_extractions table.
 *
 * Sonnet (not Haiku) is used per the slice 3 design notes — extraction quality
 * matters because the rollup layer can't recover signal that the extraction
 * step missed.
 */

'use strict';

const llmGateway = require('./llmGateway');

const EXTRACTION_MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 1500;

// Test seam — replaced in unit tests so we don't hit the LLM gateway.
let _chatCompletion = (...args) => llmGateway.chatCompletion(...args);
function _setChatCompletionForTests(fn) { _chatCompletion = fn; }
function _resetForTests() { _chatCompletion = (...args) => llmGateway.chatCompletion(...args); }

const SYSTEM_PROMPT = `You read a single GitHub pull request and extract a structured summary of what it tells us about the product and the architecture.

You will be given the PR title, the PR description, and the diff (sometimes truncated). Read all of it before responding.

Return ONLY valid JSON with the following shape — no prose, no markdown fences, no commentary:

{
  "what_changed": "one to three sentences describing what the PR did",
  "why": "one to three sentences explaining the motivation, bug fixed, or feature added",
  "product_decisions": ["bullet", "bullet"],
  "architectural_decisions": ["bullet", "bullet"],
  "patterns_established": ["bullet", "bullet"],
  "patterns_broken": ["bullet", "bullet"],
  "supersedes": ["bullet describing what this PR replaces, removes, reverses, or materially changes about prior code, features, or decisions; cite earlier PR numbers if visible"],
  "files_touched": ["server/foo.js", "client/bar.jsx"],
  "is_mechanical": false
}

Rules:
- Be conservative. Only record decisions that are clearly visible in the PR. Don't invent intent.
- "supersedes" is for ANY change that overrides earlier work — feature removals, behavior reversals, replaced approaches, deprecated decisions, renamed concepts. Look for clues like "replaces", "removes", "reverts", "deprecates", "no longer", "instead of", or files being deleted. If nothing is being superseded, return an empty array.
- PRESERVE NAMED IDENTIFIERS VERBATIM. If the PR introduces, modifies, or removes a named, user-visible thing — feature name, MCP tool name (mc_*), slash command, API endpoint path, database table or column, settings key, environment variable, eval check type, quality rule trigger, pipeline stage name, etc. — record its EXACT name in the relevant bullet. Never substitute a category description like "MCP pipeline tools" for the actual list of names. If a PR adds three new tools, list all three by name.
- For mechanical PRs (dependency bumps, typo fixes, version pins, CI tweaks, lockfile-only changes), set "is_mechanical": true and leave the decision arrays empty. Still fill "what_changed" and "files_touched".
- Each bullet should be one sentence. No nested arrays. No long paragraphs.
- Use the project's terminology directly — don't generalize names.
- "files_touched" should list at most 25 representative paths if the PR is huge.
- If a field has no content, return an empty array (or empty string for strings) — do not omit the field.`;

function buildUserPrompt(pr) {
  const title = pr.title || '(no title)';
  const body = pr.body && pr.body.trim() ? pr.body : '(no description)';
  const diff = pr.diff || '(no diff available)';
  const truncated = pr.diff_truncated ? '\n\nNOTE: The diff above was truncated due to size — focus on what is visible.' : '';
  return `PR #${pr.number}: ${title}\n\nDescription:\n${body}\n\nDiff:\n\`\`\`diff\n${diff}\n\`\`\`${truncated}`;
}

const EMPTY_EXTRACTION = {
  what_changed: '',
  why: '',
  product_decisions: [],
  architectural_decisions: [],
  patterns_established: [],
  patterns_broken: [],
  supersedes: [],
  files_touched: [],
  is_mechanical: false,
};

function normalizeExtraction(raw) {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_EXTRACTION };
  const arr = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(s => s.trim()) : []);
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    what_changed: str(raw.what_changed),
    why: str(raw.why),
    product_decisions: arr(raw.product_decisions),
    architectural_decisions: arr(raw.architectural_decisions),
    patterns_established: arr(raw.patterns_established),
    patterns_broken: arr(raw.patterns_broken),
    supersedes: arr(raw.supersedes),
    files_touched: arr(raw.files_touched).slice(0, 25),
    is_mechanical: !!raw.is_mechanical,
  };
}

function parseExtractionJson(text) {
  if (typeof text !== 'string') return null;
  // Strip leading/trailing whitespace and any accidental markdown fence.
  let trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    // Drop a leading ```json or ``` line and a trailing ```
    trimmed = trimmed.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  }
  // Attempt to locate the outermost JSON object if there is leading prose.
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return null;
  const candidate = trimmed.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch (_) {
    return null;
  }
}

/**
 * Extract a structured summary from a single PR.
 *
 * @param {object} pr — { number, title, body, diff, diff_truncated, url, merged_at }
 * @param {object} [opts] — { signal } AbortSignal forwarded to the gateway.
 * @returns {Promise<{ extraction: object, raw: string }>}
 */
async function extractPullRequest(pr, opts = {}) {
  const userPrompt = buildUserPrompt(pr);
  const raw = await _chatCompletion({
    model: EXTRACTION_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    signal: opts.signal,
  });
  const parsed = parseExtractionJson(raw);
  if (!parsed) {
    // Fall back to a minimal record so the pipeline can keep going. The raw
    // text is preserved for debugging in the database row.
    return {
      extraction: { ...EMPTY_EXTRACTION, what_changed: `(extraction failed for PR #${pr.number})` },
      raw,
    };
  }
  return { extraction: normalizeExtraction(parsed), raw };
}

module.exports = {
  extractPullRequest,
  parseExtractionJson,
  normalizeExtraction,
  buildUserPrompt,
  SYSTEM_PROMPT,
  EXTRACTION_MODEL,
  _setChatCompletionForTests,
  _resetForTests,
};
