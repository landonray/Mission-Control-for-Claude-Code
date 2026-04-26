/**
 * Test Run Recorder — orchestrates detection + parsing + persistence for
 * test runs that happen during a Claude Code session.
 *
 * Lifecycle:
 *   1. onBashToolUse(sessionId, toolUseId, input) — called when an assistant
 *      block fires a Bash tool. If the command looks like a test runner, we
 *      stash a pending entry keyed by toolUseId.
 *   2. onToolResult(sessionId, block) — called for each tool_result content
 *      block in a user event. If we have a pending entry for this tool_use_id,
 *      we extract the raw output, persist a test_run row immediately (status
 *      "parsing"), and kick off the LLM parser asynchronously. When the parse
 *      completes, the row is updated and a final broadcast is sent.
 */

const { randomUUID } = require('crypto');
const database = require('../database');
const { detectFramework } = require('./testRunDetector');
const testRunParser = require('./testRunParser');

// Test seams — production wires up to the real DB and parser; tests inject
// stubs to keep the unit tests fast and hermetic.
let _query = (...args) => database.query(...args);
let _parse = (...args) => testRunParser.parseTestOutput(...args);
function _setQueryForTests(fn) { _query = fn; }
function _setParserForTests(fn) { _parse = fn; }
function _resetForTests() {
  _query = (...args) => database.query(...args);
  _parse = (...args) => testRunParser.parseTestOutput(...args);
}

// Map of sessionId → Map<toolUseId, pendingEntry>
//   pendingEntry = { command, framework, startedAt }
// Cleared on tool_result match. Kept to bound memory if a tool_result never arrives.
const pendingByToolUse = new Map();
const MAX_PENDING_PER_SESSION = 50;

let _broadcastFn = null;

/**
 * Register a global broadcast function used to push test_run updates over the
 * WebSocket. This is wired up by index.js once the websocket server is built.
 */
function setBroadcast(fn) {
  _broadcastFn = fn;
}

function broadcast(msg) {
  if (_broadcastFn) {
    try { _broadcastFn(msg); } catch (e) { /* swallow */ }
  }
}

/**
 * Called when an assistant turn includes a Bash tool_use.
 *
 * @param {string} sessionId
 * @param {string} toolUseId — the assistant block's id (toolu_xxx)
 * @param {object} input — the tool_use input { command, description }
 */
function onBashToolUse(sessionId, toolUseId, input) {
  if (!toolUseId || !input) return;
  const command = typeof input === 'string' ? input : input.command;
  if (!command) return;

  const framework = detectFramework(command);
  if (!framework) return;

  let sessionMap = pendingByToolUse.get(sessionId);
  if (!sessionMap) {
    sessionMap = new Map();
    pendingByToolUse.set(sessionId, sessionMap);
  }
  // Bound memory: drop oldest entries if exceeded
  if (sessionMap.size >= MAX_PENDING_PER_SESSION) {
    const firstKey = sessionMap.keys().next().value;
    if (firstKey) sessionMap.delete(firstKey);
  }
  sessionMap.set(toolUseId, {
    command: String(command).slice(0, 4000),
    framework,
    startedAt: Date.now(),
  });
}

/**
 * Called for each tool_result content block in a user event.
 *
 * @param {string} sessionId
 * @param {object} block — { type: 'tool_result', tool_use_id, content, is_error }
 */
async function onToolResult(sessionId, block) {
  if (!block || block.type !== 'tool_result') return;
  const toolUseId = block.tool_use_id;
  if (!toolUseId) return;

  const sessionMap = pendingByToolUse.get(sessionId);
  if (!sessionMap) return;
  const pending = sessionMap.get(toolUseId);
  if (!pending) return;
  sessionMap.delete(toolUseId);
  if (sessionMap.size === 0) pendingByToolUse.delete(sessionId);

  const rawOutput = extractContentText(block.content);
  const durationMs = Date.now() - pending.startedAt;
  const projectId = await getSessionProjectId(sessionId);

  const runId = randomUUID();
  const initialStatus = 'parsing';
  await _query(
    `INSERT INTO test_runs (id, project_id, session_id, command, framework, status, raw_output, duration_ms, created_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NULL)`,
    [runId, projectId, sessionId, pending.command, pending.framework, initialStatus, truncateOutput(rawOutput), durationMs]
  );

  broadcast({
    type: 'test_run_started',
    sessionId,
    projectId,
    run: {
      id: runId,
      project_id: projectId,
      session_id: sessionId,
      command: pending.command,
      framework: pending.framework,
      status: initialStatus,
      duration_ms: durationMs,
      created_at: new Date().toISOString(),
    },
  });

  // Run parser async — don't block the stream event loop.
  _parse(rawOutput, { framework: pending.framework })
    .then(result => persistParsedResult(runId, result, projectId, sessionId))
    .catch(err => persistParseError(runId, err, projectId, sessionId));
}

async function persistParsedResult(runId, result, projectId, sessionId) {
  const { status, total, passed, failed, failures } = result;
  await _query(
    `UPDATE test_runs
        SET status = $1,
            total = $2,
            passed = $3,
            failed = $4,
            failures = $5::jsonb,
            completed_at = NOW()
      WHERE id = $6`,
    [status, total, passed, failed, JSON.stringify(failures || []), runId]
  );

  broadcast({
    type: 'test_run_completed',
    sessionId,
    projectId,
    run: {
      id: runId,
      project_id: projectId,
      session_id: sessionId,
      status,
      total,
      passed,
      failed,
      failures,
    },
  });
}

async function persistParseError(runId, err, projectId, sessionId) {
  const message = err && err.message ? String(err.message).slice(0, 200) : 'Unknown error';
  const failures = [{ name: 'Parser error', file: null, message }];
  await _query(
    `UPDATE test_runs
        SET status = 'unknown',
            failures = $1::jsonb,
            completed_at = NOW()
      WHERE id = $2`,
    [JSON.stringify(failures), runId]
  );

  broadcast({
    type: 'test_run_completed',
    sessionId,
    projectId,
    run: {
      id: runId,
      project_id: projectId,
      session_id: sessionId,
      status: 'unknown',
      failures,
    },
  });
}

async function getSessionProjectId(sessionId) {
  try {
    const { rows } = await _query('SELECT project_id FROM sessions WHERE id = $1', [sessionId]);
    return rows[0]?.project_id || null;
  } catch {
    return null;
  }
}

/**
 * tool_result.content can be a string or an array of content blocks
 * ({type: 'text', text: '...'}). Flatten to a single string.
 */
function extractContentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object') return c.text || c.content || '';
        return '';
      })
      .join('\n');
  }
  if (typeof content === 'object' && content.text) return String(content.text);
  return JSON.stringify(content).slice(0, 50000);
}

const RAW_OUTPUT_LIMIT = 50000;
function truncateOutput(text) {
  if (!text) return '';
  if (text.length <= RAW_OUTPUT_LIMIT) return text;
  const half = Math.floor(RAW_OUTPUT_LIMIT / 2) - 50;
  return `${text.slice(0, half)}\n\n... [truncated ${text.length - RAW_OUTPUT_LIMIT} chars] ...\n\n${text.slice(-half)}`;
}

function _resetPendingForTests() {
  pendingByToolUse.clear();
}

module.exports = {
  setBroadcast,
  onBashToolUse,
  onToolResult,
  _resetPendingForTests,
  _setQueryForTests,
  _setParserForTests,
  _resetForTests,
};
