/**
 * Context Document Orchestrator — drives the full per-PR extraction → rollup
 * → write-to-disk pipeline for one project.
 *
 * Lifecycle:
 *   1. Caller invokes startGeneration(projectId). It validates state, creates
 *      a context_doc_runs row, broadcasts a "started" event, and returns the
 *      run id immediately. The actual pipeline runs in the background.
 *   2. The pipeline progresses through phases: fetching → extracting →
 *      rolling_up → finalizing → completed. Each phase change updates the
 *      DB row and broadcasts a "progress" event.
 *   3. On terminal state (completed | failed) the row is finalized and a
 *      final broadcast is sent.
 *
 * Concurrency: only one run per project may be active at a time. A second
 * call while a run is active throws CONCURRENT_RUN_ERROR.
 *
 * Test seams: every external dependency is replaceable via _setForTests so
 * the orchestrator can be unit-tested without GitHub, the LLM gateway, or
 * the filesystem.
 */

'use strict';

const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const database = require('../database');
const githubPrFetcher = require('./githubPrFetcher');
const contextDocExtractor = require('./contextDocExtractor');
const contextDocRollup = require('./contextDocRollup');
const contextDocVerifiers = require('./contextDocVerifiers');
const { getGithubRepoFromGitRemote } = require('./railway');

// --- test seams --------------------------------------------------------------

let _query = (...args) => database.query(...args);
let _listMergedPRs = (...args) => githubPrFetcher.listMergedPullRequests(...args);
let _fetchPRDetails = (...args) => githubPrFetcher.fetchPullRequestDetails(...args);
let _extractPR = (...args) => contextDocExtractor.extractPullRequest(...args);
let _rollupBatch = (...args) => contextDocRollup.rollupBatch(...args);
let _rollupFinal = (...args) => contextDocRollup.rollupFinal(...args);
let _writeFile = (filePath, content) => fs.promises.writeFile(filePath, content, 'utf8');
let _detectGithubRepoFromGit = (projectPath) => getGithubRepoFromGitRemote(projectPath);
let _runVerifiers = (...args) => contextDocVerifiers.runAllVerifiers(...args);

function _setForTests(overrides = {}) {
  if (overrides.query) _query = overrides.query;
  if (overrides.listMergedPRs) _listMergedPRs = overrides.listMergedPRs;
  if (overrides.fetchPRDetails) _fetchPRDetails = overrides.fetchPRDetails;
  if (overrides.extractPR) _extractPR = overrides.extractPR;
  if (overrides.rollupBatch) _rollupBatch = overrides.rollupBatch;
  if (overrides.rollupFinal) _rollupFinal = overrides.rollupFinal;
  if (overrides.writeFile) _writeFile = overrides.writeFile;
  if (overrides.detectGithubRepoFromGit) _detectGithubRepoFromGit = overrides.detectGithubRepoFromGit;
  if (overrides.runVerifiers) _runVerifiers = overrides.runVerifiers;
}

function _resetForTests() {
  _query = (...args) => database.query(...args);
  _listMergedPRs = (...args) => githubPrFetcher.listMergedPullRequests(...args);
  _fetchPRDetails = (...args) => githubPrFetcher.fetchPullRequestDetails(...args);
  _extractPR = (...args) => contextDocExtractor.extractPullRequest(...args);
  _rollupBatch = (...args) => contextDocRollup.rollupBatch(...args);
  _rollupFinal = (...args) => contextDocRollup.rollupFinal(...args);
  _writeFile = (filePath, content) => fs.promises.writeFile(filePath, content, 'utf8');
  _detectGithubRepoFromGit = (projectPath) => getGithubRepoFromGitRemote(projectPath);
  _runVerifiers = (...args) => contextDocVerifiers.runAllVerifiers(...args);
}

// --- broadcast ---------------------------------------------------------------

let _broadcastFn = null;
function setBroadcast(fn) { _broadcastFn = fn; }
function broadcast(msg) {
  if (_broadcastFn) {
    try { _broadcastFn(msg); } catch (_) { /* swallow */ }
  }
}

// --- constants ---------------------------------------------------------------

const EXTRACTION_CONCURRENCY = 5;
const PHASE = Object.freeze({
  FETCHING: 'fetching',
  EXTRACTING: 'extracting',
  ROLLING_UP: 'rolling_up',
  FINALIZING: 'finalizing',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

class ConcurrentRunError extends Error {
  constructor(projectId) {
    super(`A context-doc run is already in progress for project ${projectId}`);
    this.code = 'CONCURRENT_RUN';
  }
}

// --- public API --------------------------------------------------------------

/**
 * On server boot, any context_doc_runs row left in status='running' is an
 * orphan from a process that crashed or was restarted mid-pipeline. Mark it
 * as failed with a clear, machine-detectable message so the project is
 * unblocked for a new run and the frontend can surface a "Resume" button.
 *
 * Resuming is safe because per-PR extractions are cached in
 * context_doc_extractions and skipped on the next run.
 *
 * @returns {Promise<number>} number of rows recovered
 */
async function recoverInterruptedRuns() {
  const { rows } = await _query(
    `SELECT id, project_id FROM context_doc_runs WHERE status = 'running'`
  );
  if (rows.length === 0) return 0;
  const message = 'Interrupted by server restart — click Resume to continue from cached extractions.';
  for (const row of rows) {
    await failRun(row.id, row.project_id, message);
  }
  return rows.length;
}

async function getLatestRun(projectId) {
  const { rows } = await _query(
    `SELECT id, project_id, status, phase, prs_total, prs_extracted,
            batches_total, batches_done, error_message, log_lines,
            created_at, completed_at
       FROM context_doc_runs
      WHERE project_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [projectId]
  );
  return rows[0] || null;
}

async function getActiveRun(projectId) {
  const { rows } = await _query(
    `SELECT id FROM context_doc_runs
      WHERE project_id = $1 AND status = 'running'
      ORDER BY created_at DESC
      LIMIT 1`,
    [projectId]
  );
  return rows[0] || null;
}

async function getProject(projectId) {
  const { rows } = await _query(
    'SELECT id, name, root_path, github_repo FROM projects WHERE id = $1',
    [projectId]
  );
  return rows[0] || null;
}

/**
 * Kick off a context-doc generation run for a project. Returns the new run id
 * after the row is created and the first broadcast is sent. The pipeline
 * itself runs in the background; callers should poll getLatestRun or listen
 * for context_doc_run_progress / context_doc_run_completed broadcasts.
 *
 * @param {string} projectId
 * @returns {Promise<string>} runId
 */
async function startGeneration(projectId) {
  const project = await getProject(projectId);
  if (!project) {
    const err = new Error(`Project ${projectId} not found`);
    err.code = 'PROJECT_NOT_FOUND';
    throw err;
  }
  if (!project.github_repo && project.root_path) {
    const detected = _detectGithubRepoFromGit(project.root_path);
    if (detected) project.github_repo = detected;
  }
  if (!project.github_repo) {
    const err = new Error(`Project ${project.name} has no github_repo set — cannot fetch PRs`);
    err.code = 'NO_GITHUB_REPO';
    throw err;
  }
  const active = await getActiveRun(projectId);
  if (active) throw new ConcurrentRunError(projectId);

  const runId = randomUUID();
  await _query(
    `INSERT INTO context_doc_runs (id, project_id, status, phase, log_lines, created_at)
     VALUES ($1, $2, 'running', $3, '[]'::jsonb, NOW())`,
    [runId, projectId, PHASE.FETCHING]
  );

  broadcast({
    type: 'context_doc_run_started',
    projectId,
    run: {
      id: runId,
      project_id: projectId,
      status: 'running',
      phase: PHASE.FETCHING,
      prs_total: 0,
      prs_extracted: 0,
      batches_total: 0,
      batches_done: 0,
    },
  });

  // Fire-and-forget; errors are caught inside runPipeline and persisted.
  runPipeline(runId, project).catch(err => {
    // Defensive — runPipeline should already have handled this.
    // eslint-disable-next-line no-console
    console.error('[contextDocOrchestrator] unhandled pipeline error', err);
  });

  return runId;
}

// --- pipeline ----------------------------------------------------------------

async function runPipeline(runId, project) {
  try {
    await appendLog(runId, project.id, `Listing merged PRs for ${project.github_repo}…`);
    const prs = await _listMergedPRs(project.github_repo);
    await updateRun(runId, project.id, { prs_total: prs.length });
    await appendLog(runId, project.id, `Found ${prs.length} merged PRs.`);

    if (prs.length === 0) {
      await failRun(runId, project.id, 'No merged PRs found in the repository.');
      return;
    }

    await transitionPhase(runId, project.id, PHASE.EXTRACTING);

    // Skip PRs that already have a cached extraction (idempotent retry).
    const cachedNumbers = await listCachedExtractionNumbers(project.id, prs.map(p => p.number));
    const cachedSet = new Set(cachedNumbers);
    const toExtract = prs.filter(p => !cachedSet.has(p.number));
    if (cachedSet.size > 0) {
      await appendLog(runId, project.id,
        `Reusing ${cachedSet.size} cached extraction(s); ${toExtract.length} PRs to extract.`);
    }

    let extractedCount = cachedSet.size;
    await updateRun(runId, project.id, { prs_extracted: extractedCount });

    // Run extractions in bounded-concurrency batches.
    for (let i = 0; i < toExtract.length; i += EXTRACTION_CONCURRENCY) {
      const slice = toExtract.slice(i, i + EXTRACTION_CONCURRENCY);
      await Promise.all(slice.map(pr => extractAndStorePr(project, pr).then(() => {
        extractedCount += 1;
      }).catch(err => {
        // Per-PR failures shouldn't kill the pipeline. Record a failure
        // extraction so the rollup still has something to work with.
        return storeFailedExtraction(project.id, pr, err);
      })));
      await updateRun(runId, project.id, { prs_extracted: extractedCount });
      broadcastProgress(runId, project.id, { prs_extracted: extractedCount, prs_total: prs.length });
    }

    await transitionPhase(runId, project.id, PHASE.ROLLING_UP);

    const allExtractions = await loadExtractions(project.id, prs.map(p => p.number));
    const chunks = contextDocRollup.chunkExtractions(allExtractions);
    await updateRun(runId, project.id, { batches_total: chunks.length });
    broadcastProgress(runId, project.id, { batches_total: chunks.length, batches_done: 0 });
    await appendLog(runId, project.id, `Rolling up ${chunks.length} batch(es) of up to ${contextDocRollup.BATCH_SIZE} PRs each…`);

    // Roll up batches in parallel. Each batch is independent — they all
    // read the same set of cached extractions and produce one intermediate
    // doc each. Parallelizing turns ~7 minutes (8 batches × ~50s each) into
    // ~1 minute, bottlenecked by the slowest batch instead of their sum.
    let batchesDone = 0;
    const batchSummaries = await Promise.all(
      chunks.map(async (chunk, i) => {
        const out = await _rollupBatch(project.name, i, chunks.length, chunk);
        batchesDone += 1;
        // Order of completion is unpredictable, so progress reports the
        // running tally rather than this batch's index.
        await updateRun(runId, project.id, { batches_done: batchesDone });
        broadcastProgress(runId, project.id, { batches_done: batchesDone, batches_total: chunks.length });
        await appendLog(runId, project.id, `Batch ${i + 1}/${chunks.length} rolled up.`);
        return {
          output: out,
          dateRange: {
            start: chunk[0]?.pr_merged_at || null,
            end: chunk[chunk.length - 1]?.pr_merged_at || null,
          },
        };
      })
    );

    await transitionPhase(runId, project.id, PHASE.FINALIZING);

    let canonicalIdentifiers = [];
    try {
      canonicalIdentifiers = await _runVerifiers(project.root_path);
      const summary = canonicalIdentifiers
        .filter(c => c && c.items && c.items.length > 0)
        .map(c => `${c.category}: ${c.items.length}`)
        .join(', ');
      if (summary) {
        await appendLog(runId, project.id, `Verifiers grounded synthesis with ${summary}.`);
      }
    } catch (err) {
      // Verifier failures are non-fatal — fall back to LLM-only synthesis.
      await appendLog(runId, project.id, `Verifiers failed (${err.message}); proceeding without ground-truth lists.`);
    }

    await appendLog(runId, project.id, 'Synthesizing final PRODUCT.md and ARCHITECTURE.md…');

    const { product, architecture } = await _rollupFinal(
      project.name, batchSummaries, prs.length, { canonicalIdentifiers }
    );

    const productPath = path.join(project.root_path, 'PRODUCT.md');
    const architecturePath = path.join(project.root_path, 'ARCHITECTURE.md');
    await _writeFile(productPath, product);
    await _writeFile(architecturePath, architecture);
    await appendLog(runId, project.id, `Wrote ${productPath} and ${architecturePath}.`);

    await completeRun(runId, project.id);
  } catch (err) {
    const message = err && err.message ? String(err.message) : 'Unknown error';
    await failRun(runId, project.id, message.slice(0, 1000));
  }
}

async function extractAndStorePr(project, pr) {
  const details = await _fetchPRDetails(project.github_repo, pr.number);
  const enriched = { ...pr, diff: details.diff, diff_truncated: details.diff_truncated };
  const { extraction } = await _extractPR(enriched);
  await _query(
    `INSERT INTO context_doc_extractions
       (project_id, pr_number, pr_title, pr_url, pr_merged_at, extraction, extracted_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
     ON CONFLICT (project_id, pr_number) DO UPDATE
       SET pr_title = EXCLUDED.pr_title,
           pr_url = EXCLUDED.pr_url,
           pr_merged_at = EXCLUDED.pr_merged_at,
           extraction = EXCLUDED.extraction,
           extracted_at = NOW()`,
    [project.id, pr.number, pr.title, pr.url, pr.merged_at, JSON.stringify(extraction)]
  );
}

async function storeFailedExtraction(projectId, pr, err) {
  const message = err && err.message ? err.message : 'unknown error';
  const extraction = {
    what_changed: `(extraction failed: ${String(message).slice(0, 200)})`,
    why: '',
    product_decisions: [],
    architectural_decisions: [],
    patterns_established: [],
    patterns_broken: [],
    files_touched: [],
    is_mechanical: false,
  };
  await _query(
    `INSERT INTO context_doc_extractions
       (project_id, pr_number, pr_title, pr_url, pr_merged_at, extraction, extracted_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
     ON CONFLICT (project_id, pr_number) DO NOTHING`,
    [projectId, pr.number, pr.title, pr.url, pr.merged_at, JSON.stringify(extraction)]
  );
}

async function listCachedExtractionNumbers(projectId, prNumbers) {
  if (prNumbers.length === 0) return [];
  const { rows } = await _query(
    `SELECT pr_number FROM context_doc_extractions
      WHERE project_id = $1 AND pr_number = ANY($2::int[])`,
    [projectId, prNumbers]
  );
  return rows.map(r => r.pr_number);
}

async function loadExtractions(projectId, prNumbers) {
  if (prNumbers.length === 0) return [];
  const { rows } = await _query(
    `SELECT pr_number, pr_title, pr_url, pr_merged_at, extraction
       FROM context_doc_extractions
      WHERE project_id = $1 AND pr_number = ANY($2::int[])
      ORDER BY pr_merged_at ASC, pr_number ASC`,
    [projectId, prNumbers]
  );
  // extraction comes back already parsed (JSONB); guard against string form
  return rows.map(r => ({
    ...r,
    extraction: typeof r.extraction === 'string' ? safeParse(r.extraction) : r.extraction,
  }));
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// --- run-row updates ---------------------------------------------------------

async function updateRun(runId, projectId, fields) {
  const sets = [];
  const params = [];
  let idx = 1;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${idx}`);
    params.push(v);
    idx += 1;
  }
  params.push(runId);
  await _query(`UPDATE context_doc_runs SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}

async function transitionPhase(runId, projectId, phase) {
  await updateRun(runId, projectId, { phase });
  broadcastProgress(runId, projectId, { phase });
}

async function appendLog(runId, projectId, line) {
  // Read-modify-write the log array in JS — keeps the SQL trivial and bounds
  // the row size to the most recent 100 lines.
  const { rows } = await _query('SELECT log_lines FROM context_doc_runs WHERE id = $1', [runId]);
  const current = Array.isArray(rows[0]?.log_lines) ? rows[0].log_lines : [];
  const next = [...current, line].slice(-100);
  await _query(
    'UPDATE context_doc_runs SET log_lines = $1::jsonb WHERE id = $2',
    [JSON.stringify(next), runId]
  );
  broadcast({
    type: 'context_doc_run_log',
    projectId,
    runId,
    line,
  });
}

function broadcastProgress(runId, projectId, partial) {
  broadcast({
    type: 'context_doc_run_progress',
    projectId,
    runId,
    update: partial,
  });
}

async function completeRun(runId, projectId) {
  await _query(
    `UPDATE context_doc_runs
        SET status = 'completed', phase = 'completed', completed_at = NOW()
      WHERE id = $1`,
    [runId]
  );
  const latest = await getRunById(runId);
  broadcast({
    type: 'context_doc_run_completed',
    projectId,
    run: latest,
  });
}

async function failRun(runId, projectId, message) {
  await _query(
    `UPDATE context_doc_runs
        SET status = 'failed', phase = 'failed', error_message = $1, completed_at = NOW()
      WHERE id = $2`,
    [message, runId]
  );
  const latest = await getRunById(runId);
  broadcast({
    type: 'context_doc_run_completed',
    projectId,
    run: latest,
  });
}

async function getRunById(runId) {
  const { rows } = await _query(
    `SELECT id, project_id, status, phase, prs_total, prs_extracted,
            batches_total, batches_done, error_message, log_lines,
            created_at, completed_at
       FROM context_doc_runs WHERE id = $1`,
    [runId]
  );
  return rows[0] || null;
}

module.exports = {
  startGeneration,
  getLatestRun,
  getActiveRun,
  recoverInterruptedRuns,
  setBroadcast,
  ConcurrentRunError,
  PHASE,
  _setForTests,
  _resetForTests,
};
