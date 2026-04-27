const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sessionManager = require('./sessionManager');
const planning = require('./planningSessionOrchestrator');
const orchestratorFactory = require('./pipelineOrchestrator');
const repo = require('./pipelineRepo');
const websocket = require('../websocket');
const { query } = require('../database');

let started = null;

function broadcastPipelineChanged(pipelineId) {
  try {
    websocket.broadcastToAll({ type: 'pipeline_status_changed', pipelineId });
    // The unified Decisions dashboard listens for this generic event so a
    // single subscription covers both planning escalations and pipelines.
    websocket.broadcastToAll({ type: 'decisions_changed', source: 'pipeline', pipelineId });
  } catch (err) {
    // websocket may not be initialized yet (e.g. in tests) — silent fallback
  }
}

function createBranch({ branchName, projectRootPath }) {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
      cwd: projectRootPath,
      stdio: 'ignore',
    });
    return; // already exists
  } catch (_) {
    // does not exist — fall through to create
  }
  execFileSync('git', ['branch', branchName], { cwd: projectRootPath, stdio: 'inherit' });
}

async function startSession({
  projectId,
  sessionType,
  systemPrompt,
  task,
  pipelineId,
  pipelineStage,
  branchName,
}) {
  const projectRow = await query('SELECT id, name, root_path FROM projects WHERE id = $1', [projectId]);
  const project = projectRow.rows[0];
  if (!project) throw new Error(`Project ${projectId} not found`);

  const contextSections = await planning.loadProjectContextFiles(project.root_path);
  const contextBlock =
    contextSections.length > 0 ? `\n\n## Project context\n\n${contextSections.join('\n\n')}` : '';
  // Code review (stage 6) is read-only; everything else may write code or
  // produce documents.
  const permissionMode = sessionType === 'code_review' ? 'plan' : 'acceptEdits';
  const initialPrompt = `${systemPrompt}${contextBlock}\n\n## Your task\n\n${task}\n`;

  const session = await sessionManager.createSession({
    name: `Pipeline ${sessionType}: ${task.split('\n')[0].slice(0, 60)}`,
    workingDirectory: project.root_path,
    permissionMode,
    model: process.env.MC_PIPELINE_MODEL || 'claude-sonnet-4-6',
    sessionType,
    projectId,
    branch: branchName,
    initialPrompt,
  });

  await query(
    `UPDATE sessions SET pipeline_id = $1, pipeline_stage = $2 WHERE id = $3`,
    [pipelineId, pipelineStage, session.id]
  );
  return { sessionId: session.id };
}

function readFileExists(fullPath) {
  return fs.existsSync(fullPath);
}

function readBuildPlan(fullPath) {
  return fs.readFileSync(fullPath, 'utf8');
}

function readStageOutput(fullPath) {
  return fs.readFileSync(fullPath, 'utf8');
}

function start() {
  if (started) return started;
  const orchestrator = orchestratorFactory.create({
    createBranch,
    startSession,
    readFileExists,
    readBuildPlan,
    readStageOutput,
  });

  sessionManager.globalEvents.on('session_complete', (payload) => {
    if (!payload || !payload.pipelineId) return;
    Promise.resolve(orchestrator.handleSessionComplete(payload))
      .then(() => broadcastPipelineChanged(payload.pipelineId))
      .catch((err) => {
        console.error('pipelineOrchestrator.handleSessionComplete failed:', err);
      });
  });

  started = { orchestrator };
  return started;
}

function getOrchestrator() {
  if (!started) throw new Error('pipelineRuntime not started');
  return started.orchestrator;
}

async function approveAndBroadcast(pipelineId) {
  if (!started) throw new Error('pipelineRuntime not started');
  await started.orchestrator.approveCurrentStage(pipelineId);
  broadcastPipelineChanged(pipelineId);
}

async function rejectAndBroadcast(pipelineId, feedback) {
  if (!started) throw new Error('pipelineRuntime not started');
  await started.orchestrator.rejectCurrentStage(pipelineId, feedback);
  broadcastPipelineChanged(pipelineId);
}

// True if there is a live tmux session AND a Claude process is still running
// in its current pane. Returns false on any failure (no tmux, dead session,
// pane on a different command).
function defaultIsTmuxSessionRunning(tmuxName) {
  if (!tmuxName) return false;
  try {
    execFileSync('tmux', ['has-session', '-t', tmuxName], { stdio: 'ignore' });
  } catch (_) {
    return false;
  }
  try {
    const cmd = execFileSync(
      'tmux',
      ['display-message', '-p', '-t', tmuxName, '#{pane_current_command}'],
      { encoding: 'utf-8' }
    ).trim();
    return cmd === 'claude' || cmd === 'node';
  } catch (_) {
    return false;
  }
}

// Find pipeline sessions whose row is still 'working' or 'reviewing' but
// whose underlying tmux process is gone — these are orphans from a server
// crash or restart. For each:
//  - Stages 1, 2, 3, 5, 6, 7: re-enter the orchestrator's normal completion
//    flow. If the output file made it to disk, we record it and advance.
//    If not, the existing retry-once-then-pause logic handles it.
//  - Stage 4: pause the pipeline and reset the chunk to pending so the user
//    can retry. We don't try to guess whether half-written chunk code is
//    safe to advance past.
//
// Pass { pipelineId } to scope the sweep to a single pipeline (used by the
// manual recover endpoint / MCP tool). Omit it on startup to sweep all.
async function reconcileStuckSessions(opts = {}) {
  const orchestrator = opts.orchestrator || (started && started.orchestrator);
  if (!orchestrator) throw new Error('pipelineRuntime not started');

  const deps = {
    query: opts.query || query,
    repo: opts.repo || repo,
    isTmuxRunning: opts.isTmuxRunning || defaultIsTmuxSessionRunning,
    broadcast: opts.broadcast || broadcastPipelineChanged,
  };

  const params = [];
  let sql = `
    SELECT s.id AS session_id, s.tmux_session_name, s.pipeline_id, s.pipeline_stage
    FROM sessions s
    JOIN pipelines p ON p.id = s.pipeline_id
    WHERE s.pipeline_id IS NOT NULL
      AND s.status IN ('working', 'reviewing')
      AND p.status NOT IN ('completed', 'failed')
  `;
  if (opts.pipelineId) {
    params.push(opts.pipelineId);
    sql += ` AND s.pipeline_id = $${params.length}`;
  }
  sql += ' ORDER BY s.created_at ASC';

  const result = await deps.query(sql, params);
  const reconciled = [];

  for (const row of result.rows) {
    if (deps.isTmuxRunning(row.tmux_session_name)) {
      // Session is still alive — leave it. Normal completion will fire when it exits.
      continue;
    }

    // Mark the orphaned session row as ended so the UI stops showing it as
    // active. We do this before invoking the orchestrator so the orchestrator's
    // re-entry into handleSessionComplete sees a clean row.
    await deps.query(
      `UPDATE sessions
         SET status = 'ended',
             ended_at = COALESCE(ended_at, NOW()),
             last_activity_at = NOW()
       WHERE id = $1`,
      [row.session_id]
    );

    const stage = row.pipeline_stage;
    const pipelineId = row.pipeline_id;

    try {
      if (stage === 4) {
        const chunk = await deps.repo.findChunkBySessionId(row.session_id);
        if (chunk && chunk.status !== 'completed') {
          await deps.query(
            `UPDATE pipeline_chunks
               SET status = 'pending', session_id = NULL, started_at = NULL
             WHERE pipeline_id = $1 AND chunk_index = $2`,
            [pipelineId, chunk.chunk_index]
          );
        }
        await deps.repo.updateStatus(pipelineId, { status: 'paused_for_failure' });
        await deps.repo.createEscalation({
          pipelineId,
          stage: 4,
          summary: 'Stage 4 chunk session was interrupted by a server restart.',
          detail: chunk
            ? `Chunk ${chunk.chunk_index} ("${chunk.name}") was reset to pending. ` +
              `Use the reject/retry flow to resume the pipeline once you are ready.`
            : 'The chunk linked to the interrupted session could not be identified.',
        });
        deps.broadcast(pipelineId);
        reconciled.push({
          sessionId: row.session_id,
          pipelineId,
          stage,
          action: 'paused_chunk',
        });
        continue;
      }

      // Stages 1, 2, 3, 5, 6, 7 — defer to the orchestrator's normal completion
      // flow, which already knows how to verify the output file and advance.
      await orchestrator.handleSessionComplete({
        sessionId: row.session_id,
        pipelineId,
        pipelineStage: stage,
      });
      deps.broadcast(pipelineId);
      reconciled.push({
        sessionId: row.session_id,
        pipelineId,
        stage,
        action: 'recovered',
      });
    } catch (err) {
      console.error(
        `[pipelineRuntime] reconcileStuckSessions failed for session ${row.session_id}:`,
        err.message
      );
      reconciled.push({
        sessionId: row.session_id,
        pipelineId,
        stage,
        action: 'error',
        error: err.message,
      });
    }
  }

  return reconciled;
}

module.exports = {
  start,
  getOrchestrator,
  approveAndBroadcast,
  rejectAndBroadcast,
  reconcileStuckSessions,
  _internal: { defaultIsTmuxSessionRunning },
};
