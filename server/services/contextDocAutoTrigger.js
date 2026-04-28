/**
 * Auto-trigger for context-doc regeneration.
 *
 * Two entry points:
 *
 * 1. onBashCommand(sessionId, commandText) — call from the bash watcher
 *    every time a Bash tool runs. If the command looks like a PR merge
 *    (`gh pr merge`, `git merge` — but not `git merge-base`/`git merge-tree`
 *    which are read-only), it kicks off a debounced context-doc regen for
 *    the session's project.
 *
 * 2. runNightlySweep() — call from the daily cron. Iterates every project
 *    with a github_repo and fires startGeneration for each. The orchestrator
 *    caches per-PR extractions, so a sweep with no new PRs is cheap.
 *
 * Safety rails — both paths apply:
 *   - Debounce per project (DEBOUNCE_MS): merging two PRs back-to-back fires
 *     one regen, not many.
 *   - Skip-if-running: if a context_doc_runs row is already 'running' for
 *     the project, do nothing — that run will pick up the latest PRs.
 */

'use strict';

const database = require('../database');
const contextDocOrchestrator = require('./contextDocOrchestrator');

// --- test seams --------------------------------------------------------------

let _query = (...args) => database.query(...args);
let _startGeneration = (...args) => contextDocOrchestrator.startGeneration(...args);
let _getActiveRun = (...args) => contextDocOrchestrator.getActiveRun(...args);

function _setForTests(overrides = {}) {
  if (overrides.query) _query = overrides.query;
  if (overrides.startGeneration) _startGeneration = overrides.startGeneration;
  if (overrides.getActiveRun) _getActiveRun = overrides.getActiveRun;
}

function _resetForTests() {
  _query = (...args) => database.query(...args);
  _startGeneration = (...args) => contextDocOrchestrator.startGeneration(...args);
  _getActiveRun = (...args) => contextDocOrchestrator.getActiveRun(...args);
  pendingTimers.forEach(clearTimeout);
  pendingTimers.clear();
}

// --- constants ---------------------------------------------------------------

// Wait 60 seconds after the last detected merge before firing regen, so a
// rapid sequence of merges collapses into a single run.
const DEBOUNCE_MS = 60_000;

// Each match on this list, applied as a substring search against the bash
// command text, is considered a "PR was merged" signal. Order matters only
// for performance — the first hit wins. Patterns are deliberately strict
// to avoid false positives from read-only inspections (`git merge-base`,
// `git merge-tree`, `gh pr merge --help`).
const MERGE_PATTERNS = [
  // GitHub CLI merge with subcommand keywords that imply an actual merge.
  /\bgh\s+pr\s+merge\b(?!\s*--help)/,
  // Plain `git merge <ref>` — but NOT `git merge-base` or `git merge-tree`,
  // which are read-only inspection commands. The negative lookahead handles
  // both, plus any future `merge-*` subcommand.
  /\bgit\s+merge(?!-[a-z])(?!\s+--help)\s+\S+/,
];

// One pending debounce timer per project id.
const pendingTimers = new Map();

// --- public API --------------------------------------------------------------

/**
 * Hook for the bash watcher. Detects merge commands and schedules a
 * debounced regen for the session's project.
 */
async function onBashCommand(sessionId, commandText) {
  if (!commandText || typeof commandText !== 'string') return;
  if (!isMergeCommand(commandText)) return;

  // Look up project for the session. If unlinked, nothing to do.
  let projectId;
  try {
    const { rows } = await _query(
      'SELECT project_id FROM sessions WHERE id = $1',
      [sessionId]
    );
    projectId = rows[0]?.project_id || null;
  } catch (err) {
    console.warn('[ContextDocAutoTrigger] DB lookup failed:', err.message);
    return;
  }
  if (!projectId) {
    console.log(
      `[ContextDocAutoTrigger] Merge detected in session ${sessionId.slice(0, 8)} but session has no project_id — skipping`
    );
    return;
  }

  scheduleRegen(projectId, `merge command in session ${sessionId.slice(0, 8)}`);
}

/**
 * Daily safety-net sweep. Fires regen for every project that has a
 * github_repo configured. Per-project skip-if-running prevents stomping on
 * an in-flight run.
 */
async function runNightlySweep() {
  let projects;
  try {
    const { rows } = await _query(
      "SELECT id, name FROM projects WHERE github_repo IS NOT NULL AND github_repo <> ''"
    );
    projects = rows;
  } catch (err) {
    console.warn('[ContextDocAutoTrigger] Nightly sweep DB lookup failed:', err.message);
    return { triggered: 0, skipped: 0, failed: 0 };
  }

  let triggered = 0;
  let skipped = 0;
  let failed = 0;

  for (const project of projects) {
    try {
      const fired = await fireIfClear(project.id, `nightly sweep for "${project.name}"`);
      if (fired) triggered += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      console.warn(
        `[ContextDocAutoTrigger] Nightly sweep failed for project ${project.name}: ${err.message}`
      );
    }
  }

  console.log(
    `[ContextDocAutoTrigger] Nightly sweep: ${triggered} triggered, ${skipped} skipped, ${failed} failed`
  );
  return { triggered, skipped, failed };
}

// --- internals ---------------------------------------------------------------

function isMergeCommand(commandText) {
  return MERGE_PATTERNS.some(pattern => pattern.test(commandText));
}

/**
 * Debounce: if a regen is already scheduled for this project, restart the
 * timer. Otherwise start a fresh one.
 */
function scheduleRegen(projectId, reason) {
  const existing = pendingTimers.get(projectId);
  if (existing) {
    clearTimeout(existing);
    console.log(
      `[ContextDocAutoTrigger] Coalescing additional ${reason} into pending regen for ${projectId}`
    );
  } else {
    console.log(
      `[ContextDocAutoTrigger] Scheduling regen for ${projectId} in ${DEBOUNCE_MS / 1000}s (${reason})`
    );
  }

  const timer = setTimeout(async () => {
    pendingTimers.delete(projectId);
    try {
      await fireIfClear(projectId, reason);
    } catch (err) {
      console.warn(
        `[ContextDocAutoTrigger] Regen for ${projectId} failed: ${err.message}`
      );
    }
  }, DEBOUNCE_MS);
  // Don't keep the Node process alive just for the debounce timer.
  if (typeof timer.unref === 'function') timer.unref();
  pendingTimers.set(projectId, timer);
}

/**
 * Skip-if-running: ask the orchestrator whether a run is already active.
 * If so, skip and let the in-flight run cover the new merge. Otherwise
 * call startGeneration.
 *
 * Returns true when a regen was kicked off, false when skipped.
 */
async function fireIfClear(projectId, reason) {
  const active = await _getActiveRun(projectId).catch(() => null);
  if (active) {
    console.log(
      `[ContextDocAutoTrigger] Skipping ${reason} — run ${active.id?.slice?.(0, 8) || 'active'} already in progress for project ${projectId}`
    );
    return false;
  }
  try {
    const runId = await _startGeneration(projectId);
    console.log(
      `[ContextDocAutoTrigger] Triggered context-doc regen ${runId.slice(0, 8)} for project ${projectId} (${reason})`
    );
    return true;
  } catch (err) {
    // CONCURRENT_RUN, NO_GITHUB_REPO, PROJECT_NOT_FOUND — log and move on.
    console.log(
      `[ContextDocAutoTrigger] startGeneration declined for ${projectId} (${reason}): ${err.code || err.message}`
    );
    return false;
  }
}

module.exports = {
  onBashCommand,
  runNightlySweep,
  isMergeCommand,
  DEBOUNCE_MS,
  _setForTests,
  _resetForTests,
};
