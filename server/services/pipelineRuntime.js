const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sessionManager = require('./sessionManager');
const planning = require('./planningSessionOrchestrator');
const orchestratorFactory = require('./pipelineOrchestrator');
const websocket = require('../websocket');
const { query } = require('../database');

let started = null;

function broadcastPipelineChanged(pipelineId) {
  try {
    websocket.broadcastToAll({ type: 'pipeline_status_changed', pipelineId });
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
  const initialPrompt = `${systemPrompt}${contextBlock}\n\n## Your task\n\n${task}\n`;

  const session = await sessionManager.createSession({
    name: `Pipeline ${sessionType}: ${task.split('\n')[0].slice(0, 60)}`,
    workingDirectory: project.root_path,
    permissionMode: 'acceptEdits',
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

function start() {
  if (started) return started;
  const orchestrator = orchestratorFactory.create({ createBranch, startSession, readFileExists });

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

module.exports = { start, getOrchestrator, approveAndBroadcast, rejectAndBroadcast };
