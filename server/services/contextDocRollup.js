/**
 * Roll-up synthesis layer for the context document pipeline.
 *
 * Two phases:
 *   1. Per-batch synthesis (chunks of 25 extractions → one intermediate doc).
 *   2. Final synthesis (all batch outputs + extraction sample → final
 *      PRODUCT.md and ARCHITECTURE.md).
 *
 * If the project has 25 or fewer PRs, phase 1 produces a single batch and
 * phase 2 still runs to do the product/architecture split — this keeps the
 * code path uniform regardless of project size.
 *
 * Output: an object with `product` and `architecture` markdown strings,
 * ready to write to disk.
 */

'use strict';

const llmGateway = require('./llmGateway');

const ROLLUP_MODEL = 'claude-sonnet-4-5';
const BATCH_SIZE = 25;
const BATCH_MAX_TOKENS = 4000;
const FINAL_MAX_TOKENS = 12000;

const PRODUCT_BEGIN = '===BEGIN PRODUCT.md===';
const PRODUCT_END = '===END PRODUCT.md===';
const ARCH_BEGIN = '===BEGIN ARCHITECTURE.md===';
const ARCH_END = '===END ARCHITECTURE.md===';

let _chatCompletion = (...args) => llmGateway.chatCompletion(...args);
function _setChatCompletionForTests(fn) { _chatCompletion = fn; }
function _resetForTests() { _chatCompletion = (...args) => llmGateway.chatCompletion(...args); }

const BATCH_SYSTEM_PROMPT = `You are synthesizing structured PR extractions into an intermediate roll-up document.

You will receive a chronological batch of up to 25 per-PR extractions for a single project. Each extraction lists what changed, why, product decisions, architectural decisions, patterns established, patterns broken, and what it supersedes (replaces, removes, or reverses from earlier work). PRs are ordered oldest first.

Produce a structured intermediate roll-up that the final synthesis pass can merge with other batches. Use this exact format:

# Batch Roll-up

## Product themes
- bullet (one short sentence per theme; cite PR numbers in parens like "(#12, #34)")

## Architectural decisions and patterns
- bullet — current approach (cite PR numbers)

## Superseded within this batch
- bullet — current state as of the latest PR (#X, date), overrode previous approach from (#Y, date). Briefly explain why if the PRs make it clear.

## Mechanical-only PRs
- comma-separated list of PR numbers that had no significant decisions

## Areas of uncertainty
- bullet — note where the PR signal is ambiguous or thin

Conflict resolution rules — read carefully:
- If two PRs in this batch describe conflicting state about the same feature, decision, or pattern, treat the most recent PR as the current state. Do not list both as if they coexist.
- Pay close attention to the "supersedes" field on each extraction — that is an explicit signal that something earlier was overridden.
- Also infer supersession when later PRs change behavior even if "supersedes" is empty (e.g., a feature mentioned in PR #5 is removed by PR #20 even if #20 didn't call it out).
- When supersession is found, describe ONLY the current state in the relevant theme/decision section. Record the override in "Superseded within this batch" with both PR numbers and dates.
- Skip mechanical PRs from the themes/decisions sections.
- Be specific. Use the project's terminology directly. Avoid generic phrases like "improved code quality".
- One sentence per bullet.
- If a section has no content, write "_(none in this batch)_" under it.`;

const FINAL_SYSTEM_PROMPT = `You are writing two living context documents — PRODUCT.md and ARCHITECTURE.md — for a single project, by synthesizing a set of intermediate batch roll-ups derived from the project's PR history.

These documents will be loaded by future Claude Code sessions at startup, so they must be a clear, navigable reference — not a chronological log. Organize by topic, not by date.

Output format — emit BOTH documents using these exact delimiter lines, with the markdown content in between. No prose outside the delimiters, no code fences:

${PRODUCT_BEGIN}
<full PRODUCT.md content as raw markdown>
${PRODUCT_END}

${ARCH_BEGIN}
<full ARCHITECTURE.md content as raw markdown>
${ARCH_END}

PRODUCT.md must use this top-level structure:

# Product

> Auto-generated from PR history. Edit freely — future roll-ups will preserve manual additions.

## Purpose and scope
## Key features and current state
## Product decisions and rationale
## Scoping decisions
## Superseded product decisions
## Open questions and known gaps

ARCHITECTURE.md must use this top-level structure:

# Architecture

> Auto-generated from PR history. Edit freely — future roll-ups will preserve manual additions.

## System overview
## Data model
## Established patterns
## Patterns tried and abandoned
## Integration points
## Key technical decisions

Conflict resolution rules — read carefully:
- The batch roll-ups you receive are ordered chronologically and labeled with their date ranges. Earlier batches describe earlier state; later batches describe later state.
- Each batch may include a "Superseded within this batch" section. Honor those — the current state is the later one in each pair.
- ALSO compare claims across batches. If batch 1 says feature X works one way and batch 5 says feature X works another way, the batch 5 version is the current truth. The batch 1 version belongs in "Superseded product decisions" or "Patterns tried and abandoned" — never present both as if they coexist.
- When you record a supersession, write it as: "Current state: <later approach> (#X, YYYY-MM-DD). Previously: <earlier approach> (#Y, YYYY-MM-DD). Reason: <if clear>." Skip the reason line if not clear.
- Do not assume something still exists just because an early PR introduced it. Verify it survived through the latest batch.

Rules for both documents:
- Cite PR numbers in parens (e.g., "(see #12, #34)") sparingly — only where the citation is clearly grounding the claim.
- Keep bullet points to one or two sentences each.
- If a section truly has no content from the input, write a single italic line "_No signal yet — fill in during review._" rather than inventing content.
- Use the project's own terminology. Don't generalize names of features or services.
- Mark genuinely uncertain items inline with "[REVIEW: ...]".`;

function chunkExtractions(extractions) {
  const chunks = [];
  for (let i = 0; i < extractions.length; i += BATCH_SIZE) {
    chunks.push(extractions.slice(i, i + BATCH_SIZE));
  }
  return chunks;
}

function formatExtractionForPrompt(row) {
  const e = row.extraction || {};
  const lines = [];
  lines.push(`### PR #${row.pr_number}: ${row.pr_title || '(untitled)'}`);
  if (row.pr_merged_at) lines.push(`Merged: ${row.pr_merged_at}`);
  if (e.is_mechanical) {
    lines.push('Mechanical: yes');
  }
  if (e.what_changed) lines.push(`What changed: ${e.what_changed}`);
  if (e.why) lines.push(`Why: ${e.why}`);
  if (e.product_decisions?.length) {
    lines.push('Product decisions:');
    for (const d of e.product_decisions) lines.push(`  - ${d}`);
  }
  if (e.architectural_decisions?.length) {
    lines.push('Architectural decisions:');
    for (const d of e.architectural_decisions) lines.push(`  - ${d}`);
  }
  if (e.patterns_established?.length) {
    lines.push('Patterns established:');
    for (const p of e.patterns_established) lines.push(`  - ${p}`);
  }
  if (e.patterns_broken?.length) {
    lines.push('Patterns broken:');
    for (const p of e.patterns_broken) lines.push(`  - ${p}`);
  }
  if (e.supersedes?.length) {
    lines.push('Supersedes (overrides earlier work):');
    for (const s of e.supersedes) lines.push(`  - ${s}`);
  }
  return lines.join('\n');
}

function buildBatchUserPrompt(projectName, batchIndex, totalBatches, extractions) {
  const header = `Project: ${projectName}\nBatch: ${batchIndex + 1} of ${totalBatches}\nPR count in this batch: ${extractions.length}\n\n`;
  const body = extractions.map(formatExtractionForPrompt).join('\n\n');
  return `${header}Extractions:\n\n${body}`;
}

function buildFinalUserPrompt(projectName, batchSummaries, totalPrs) {
  const header = `Project: ${projectName}\nTotal PRs analyzed: ${totalPrs}\nBatches: ${batchSummaries.length}\n\n`;
  const body = batchSummaries
    .map((b, i) => {
      const range = formatDateRange(b.dateRange);
      const suffix = range ? ` (PRs merged ${range})` : '';
      return `## Batch ${i + 1} roll-up${suffix}\n\n${b.output}`;
    })
    .join('\n\n---\n\n');
  return `${header}${body}\n\nNow synthesize PRODUCT.md and ARCHITECTURE.md following the rules in the system prompt. Remember: later batches override earlier ones when they conflict.`;
}

function formatDateRange(range) {
  if (!range) return null;
  const start = formatDate(range.start);
  const end = formatDate(range.end);
  if (!start && !end) return null;
  if (start === end) return start;
  return `${start || '?'} to ${end || '?'}`;
}

function formatDate(value) {
  if (!value) return null;
  const s = String(value);
  // Accept ISO timestamps or plain date strings; keep just the date portion.
  return s.slice(0, 10);
}

function extractBlock(text, beginMarker, endMarker) {
  const beginIdx = text.indexOf(beginMarker);
  if (beginIdx === -1) return null;
  const contentStart = beginIdx + beginMarker.length;
  const endIdx = text.indexOf(endMarker, contentStart);
  if (endIdx === -1) return null;
  return text.slice(contentStart, endIdx).replace(/^\r?\n/, '').replace(/\r?\n\s*$/, '');
}

function parseFinalOutput(text) {
  if (typeof text !== 'string') return null;
  const product = extractBlock(text, PRODUCT_BEGIN, PRODUCT_END);
  const architecture = extractBlock(text, ARCH_BEGIN, ARCH_END);
  if (product === null || architecture === null) return null;
  return { product, architecture };
}

/**
 * Roll up a single batch of extractions into an intermediate markdown summary.
 *
 * @param {string} projectName
 * @param {number} batchIndex — zero-based
 * @param {number} totalBatches
 * @param {Array} extractions — rows from context_doc_extractions
 * @param {object} [opts] — { signal }
 * @returns {Promise<string>} markdown
 */
async function rollupBatch(projectName, batchIndex, totalBatches, extractions, opts = {}) {
  const userPrompt = buildBatchUserPrompt(projectName, batchIndex, totalBatches, extractions);
  return _chatCompletion({
    model: ROLLUP_MODEL,
    max_tokens: BATCH_MAX_TOKENS,
    system: BATCH_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    signal: opts.signal,
  });
}

/**
 * Final synthesis — merge all batch outputs into PRODUCT.md + ARCHITECTURE.md.
 *
 * @param {string} projectName
 * @param {Array<string | { output: string, dateRange?: { start, end } }>} batchSummaries
 *   Each entry is either a raw markdown string (legacy) or an object with the
 *   batch markdown and the date range of PRs in that batch. Date ranges let
 *   the synthesis pass apply recency-wins resolution across batches.
 * @param {number} totalPrs
 * @param {object} [opts] — { signal }
 * @returns {Promise<{ product: string, architecture: string }>}
 */
async function rollupFinal(projectName, batchSummaries, totalPrs, opts = {}) {
  const normalized = batchSummaries.map(b =>
    typeof b === 'string' ? { output: b, dateRange: null } : b
  );
  const userPrompt = buildFinalUserPrompt(projectName, normalized, totalPrs);
  const raw = await _chatCompletion({
    model: ROLLUP_MODEL,
    max_tokens: FINAL_MAX_TOKENS,
    system: FINAL_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    signal: opts.signal,
  });
  const parsed = parseFinalOutput(raw);
  if (!parsed || !parsed.product || !parsed.architecture) {
    const rawStr = String(raw);
    throw new Error(
      'Final rollup did not return both PRODUCT.md and ARCHITECTURE.md blocks with the expected delimiters. ' +
      `Raw length: ${rawStr.length} chars. First 300: ${rawStr.slice(0, 300)} | Last 300: ${rawStr.slice(-300)}`
    );
  }
  return { product: parsed.product, architecture: parsed.architecture };
}

module.exports = {
  rollupBatch,
  rollupFinal,
  chunkExtractions,
  formatExtractionForPrompt,
  parseFinalOutput,
  ROLLUP_MODEL,
  BATCH_SIZE,
  _setChatCompletionForTests,
  _resetForTests,
};
