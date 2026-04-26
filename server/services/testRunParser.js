/**
 * Test Run Parser — extracts a structured summary from raw test output.
 *
 * Uses the free Claude CLI (the same path the quality rules use) so we
 * can support any framework's output format without writing per-framework
 * regex parsers.
 */

const cliAgent = require('./cliAgent');

const MAX_OUTPUT_CHARS = 12000;
const PARSE_TIMEOUT_MS = 60000;

// Test seam — production code calls cliAgent.run via this indirection so tests
// can swap in a stub without needing module-level mocks (which are flaky for CJS).
let _runner = (...args) => cliAgent.run(...args);
function _setRunnerForTests(fn) { _runner = fn; }
function _resetRunnerForTests() { _runner = (...args) => cliAgent.run(...args); }

const PARSE_PROMPT = `You are parsing the output of a software test run. Extract a structured summary.

Read the test output below and respond with ONLY a JSON object on a single line, no markdown, no commentary, no code fences. The JSON object must have exactly these fields:

{
  "status": "passed" | "failed" | "unknown",
  "total": <integer or null>,
  "passed": <integer or null>,
  "failed": <integer or null>,
  "failures": [{"name": "<test name>", "file": "<file path or null>", "message": "<one-line description of why it failed, max 200 chars>"}]
}

Rules:
- "status" is "passed" if every test passed, "failed" if at least one test failed or the runner crashed, "unknown" if you genuinely cannot tell.
- If the output shows a count like "10 passed, 2 failed" use those numbers. If counts are not stated, use null.
- "failures" is an array of every failed test you can identify. Empty array if none failed.
- Each "message" should be a single-line plain-English description of the failure (the assertion that failed, the error name, etc.). Strip ANSI color codes. Keep it under 200 characters.
- If no failures are listed but status is "failed" (e.g. compile error, runner crash), put one entry in "failures" describing the top-level error.
- Do NOT include passing tests in the failures array.
- If the output is not actually a test run (e.g. just an error message about a missing command), respond with status="unknown" and empty failures.

Test output:
---
{{OUTPUT}}
---

Respond with the JSON object only.`;

/**
 * Parse raw test output into a structured summary using the CLI agent.
 *
 * @param {string} rawOutput — the full stdout/stderr from the test command
 * @param {object} [options]
 * @param {string} [options.framework] — optional hint, included in the prompt
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{status: string, total: number|null, passed: number|null, failed: number|null, failures: Array<{name: string, file: string|null, message: string}>}>}
 */
async function parseTestOutput(rawOutput, options = {}) {
  const { signal } = options;
  const truncated = truncateForPrompt(rawOutput);
  const prompt = PARSE_PROMPT.replace('{{OUTPUT}}', truncated);

  let raw;
  try {
    raw = await _runner(prompt, { timeout: PARSE_TIMEOUT_MS, signal });
  } catch (err) {
    return fallbackResult(rawOutput, `Parser CLI call failed: ${err.message}`);
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    return fallbackResult(rawOutput, 'Parser returned non-JSON output');
  }

  return normalize(parsed);
}

/**
 * Truncate output for the prompt — keep head and tail because failures
 * usually appear near the end, but the framework banner is at the top.
 */
function truncateForPrompt(text) {
  if (!text) return '(empty output)';
  const stripped = stripAnsi(text);
  if (stripped.length <= MAX_OUTPUT_CHARS) return stripped;
  const half = Math.floor(MAX_OUTPUT_CHARS / 2) - 50;
  return `${stripped.slice(0, half)}\n\n... [output truncated — middle ${stripped.length - MAX_OUTPUT_CHARS} chars omitted] ...\n\n${stripped.slice(-half)}`;
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b?\[[0-9;]*m/g, '');
}

function extractJson(text) {
  if (!text) return null;
  const trimmed = text.trim();

  // First try a direct parse
  try { return JSON.parse(trimmed); } catch { /* try harder */ }

  // Strip markdown fences if present
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* try harder */ }
  }

  // Find first { ... last } and try that
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { /* give up */ }
  }
  return null;
}

function normalize(parsed) {
  const status = ['passed', 'failed', 'unknown'].includes(parsed.status) ? parsed.status : 'unknown';
  const total = toIntOrNull(parsed.total);
  const passed = toIntOrNull(parsed.passed);
  const failed = toIntOrNull(parsed.failed);

  const failuresInput = Array.isArray(parsed.failures) ? parsed.failures : [];
  const failures = failuresInput.slice(0, 100).map(f => ({
    name: String(f?.name || 'unnamed test').slice(0, 300),
    file: f?.file ? String(f.file).slice(0, 500) : null,
    message: String(f?.message || '').replace(/\s+/g, ' ').slice(0, 200),
  }));

  return { status, total, passed, failed, failures };
}

function toIntOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function fallbackResult(rawOutput, reason) {
  return {
    status: 'unknown',
    total: null,
    passed: null,
    failed: null,
    failures: [{ name: 'Could not parse test output', file: null, message: reason }],
  };
}

module.exports = {
  parseTestOutput,
  _internal: { extractJson, normalize, truncateForPrompt, stripAnsi },
  _setRunnerForTests,
  _resetRunnerForTests,
};
