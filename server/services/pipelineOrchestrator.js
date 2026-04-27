const path = require('path');
const repo = require('./pipelineRepo');
const promptBuilder = require('./pipelinePromptBuilder');
const { parseBuildPlan } = require('./buildPlanParser');
const { query } = require('../database');

// Module-level retry tracking. Keyed by `${pipelineId}:${stage}`.
// Each test creates fresh pipeline IDs so keys won't collide across test cases.
const retryAttempts = new Map();

const FIX_CYCLE_CAP = 3;

function create(deps) {
  if (!deps || !deps.createBranch || !deps.startSession || !deps.readFileExists || !deps.endSession) {
    throw new Error(
      'pipelineOrchestrator.create requires deps: createBranch, startSession, readFileExists, endSession'
    );
  }

  async function safeEndSession(sessionId) {
    if (!sessionId) return;
    try {
      await deps.endSession(sessionId);
    } catch (err) {
      console.error(`pipelineOrchestrator: failed to end session ${sessionId}:`, err.message);
    }
  }

  // Optional dep — only used at the stage 3→4 transition. Falls back to fs read in production.
  const readBuildPlan = deps.readBuildPlan || ((fullPath) => {
    const fs = require('fs');
    return fs.readFileSync(fullPath, 'utf8');
  });

  // Optional dep — used by stages 5/6 to inspect their report files for status.
  const readStageOutput = deps.readStageOutput || ((fullPath) => {
    const fs = require('fs');
    return fs.readFileSync(fullPath, 'utf8');
  });

  async function getProjectRootPath(projectId) {
    const r = await query('SELECT root_path FROM projects WHERE id = $1', [projectId]);
    if (!r.rows[0]) throw new Error(`Project not found: ${projectId}`);
    return r.rows[0].root_path;
  }

  async function startStage({ pipeline, stage, rejectionFeedback, chunk, iteration }) {
    const prompts = await repo.getStagePrompts(pipeline.id);
    const stagePrompt = prompts[String(stage)];
    if (!stagePrompt) throw new Error(`No prompt for stage ${stage}`);

    const systemPrompt = promptBuilder.buildStagePrompt({
      stagePrompt,
      rejectionFeedback: rejectionFeedback || null,
    });

    const refinedSpecPath = promptBuilder.outputPathFor(1, pipeline.name);
    const qaPlanPath = promptBuilder.outputPathFor(2, pipeline.name);
    const qaReportPath = promptBuilder.outputPathFor(5, pipeline.name);
    const codeReviewPath = promptBuilder.outputPathFor(6, pipeline.name);
    const outputPath = promptBuilder.outputPathFor(stage, pipeline.name);

    let task;
    if (stage === 1) {
      task = promptBuilder.buildStageTask({
        stage: 1,
        pipelineName: pipeline.name,
        specInput: pipeline.spec_input,
        outputPath,
      });
    } else if (stage === 2) {
      task = promptBuilder.buildStageTask({
        stage: 2,
        pipelineName: pipeline.name,
        refinedSpecPath,
        outputPath,
      });
    } else if (stage === 3) {
      task = promptBuilder.buildStageTask({
        stage: 3,
        pipelineName: pipeline.name,
        refinedSpecPath,
        qaPlanPath,
        outputPath,
      });
    } else if (stage === 4) {
      if (!chunk) throw new Error('stage 4 requires a chunk');
      task = promptBuilder.buildStageTask({
        stage: 4,
        pipelineName: pipeline.name,
        refinedSpecPath,
        qaPlanPath,
        chunk,
      });
    } else if (stage === 5) {
      task = promptBuilder.buildStageTask({
        stage: 5,
        pipelineName: pipeline.name,
        refinedSpecPath,
        qaPlanPath,
        outputPath,
        iteration: iteration || 1,
      });
    } else if (stage === 6) {
      task = promptBuilder.buildStageTask({
        stage: 6,
        pipelineName: pipeline.name,
        refinedSpecPath,
        qaReportPath,
        outputPath,
      });
    } else if (stage === 7) {
      task = promptBuilder.buildStageTask({
        stage: 7,
        pipelineName: pipeline.name,
        refinedSpecPath,
        qaReportPath,
        codeReviewPath,
        iteration: iteration || 1,
      });
    } else {
      throw new Error(`Stage ${stage} not supported`);
    }

    return deps.startSession({
      projectId: pipeline.project_id,
      sessionType: promptBuilder.sessionTypeForStage(stage),
      systemPrompt,
      task,
      pipelineId: pipeline.id,
      pipelineStage: stage,
      branchName: pipeline.branch_name,
      rejectionFeedback: rejectionFeedback || null,
      chunk: chunk || null,
    });
  }

  async function createAndStart({ projectId, name, specInput, gatedStages }) {
    const active = await repo.getActivePipelineForProject(projectId);
    if (active) {
      throw new Error(
        `Project already has an active pipeline (${active.id} — "${active.name}"). ` +
          `Wait for it to complete before starting a new one.`
      );
    }

    const projectRootPath = await getProjectRootPath(projectId);
    const pipeline = await repo.createPipeline({ projectId, name, specInput, gatedStages });

    await deps.createBranch({ branchName: pipeline.branch_name, projectRootPath });
    await repo.updateStatus(pipeline.id, { status: 'running', currentStage: 1 });
    await startStage({ pipeline, stage: 1 });

    return repo.getPipeline(pipeline.id);
  }

  function isGatedStage(pipeline, stage) {
    // Per-pipeline configuration. Older pipelines without the column fall back
    // to the original behavior of gating stages 1-3.
    let stages = pipeline && pipeline.gated_stages;
    if (typeof stages === 'string') {
      try { stages = JSON.parse(stages); } catch { stages = null; }
    }
    if (!Array.isArray(stages)) stages = [1, 2, 3];
    return stages.includes(stage);
  }

  async function handleSessionComplete({ sessionId, pipelineId, pipelineStage }) {
    if (!pipelineId) return;

    const pipeline = await repo.getPipeline(pipelineId);
    if (!pipeline) return;
    if (pipeline.status === 'completed' || pipeline.status === 'failed') return;

    if (pipelineStage === 4) {
      return handleChunkSessionComplete({ pipeline, sessionId });
    }

    if (pipelineStage === 7) {
      return handleFixCycleComplete({ pipeline, sessionId });
    }

    // Stages with a tracked output document (1, 2, 3, 5, 6) — verify the file
    // was written, retry once on failure, then escalate.
    const outputPath = promptBuilder.outputPathFor(pipelineStage, pipeline.name);
    const projectRootPath = await getProjectRootPath(pipeline.project_id);
    const fullPath = path.join(projectRootPath, outputPath);
    const exists = deps.readFileExists(fullPath);

    if (!exists) {
      const retryKey = `${pipelineId}:${pipelineStage}`;
      const attempts = retryAttempts.get(retryKey) || 0;

      if (attempts === 0) {
        retryAttempts.set(retryKey, 1);
        await safeEndSession(sessionId);
        await startStage({
          pipeline,
          stage: pipelineStage,
          rejectionFeedback:
            'Your previous attempt did not produce the expected output file. ' +
            'Make sure to actually write the file at the path specified in the task before exiting.',
        });
        return;
      }

      retryAttempts.delete(retryKey);
      await safeEndSession(sessionId);
      await repo.updateStatus(pipelineId, { status: 'paused_for_failure' });
      await repo.createEscalation({
        pipelineId,
        stage: pipelineStage,
        summary: `Stage ${pipelineStage} failed twice — output file never written.`,
        detail: `Expected file: ${outputPath}`,
      });
      return;
    }

    retryAttempts.delete(`${pipelineId}:${pipelineStage}`);

    const existingOutputs = await repo.listStageOutputs(pipelineId);
    const sameStage = existingOutputs.filter((o) => o.stage === pipelineStage);
    const iteration = sameStage.length + 1;

    await repo.recordStageOutput({ pipelineId, stage: pipelineStage, iteration, outputPath });

    if (isGatedStage(pipeline, pipelineStage)) {
      // Leave the session OPEN — it stays available while the user reviews
      // the output. It will be closed when the stage is approved or rejected.
      await repo.updateStatus(pipelineId, { status: 'paused_for_approval' });
      return;
    }

    await safeEndSession(sessionId);
    await proceedFromStage(pipelineId, pipelineStage, fullPath);
  }

  // Advances the pipeline past a completed (non-gated or just-approved) stage.
  // Stage 4 (chunks) and stage 7 (fix cycle) follow their own paths and never
  // funnel through here.
  async function proceedFromStage(pipelineId, stage, fullPath) {
    if (stage === 1 || stage === 2) {
      const next = stage + 1;
      await repo.updateStatus(pipelineId, { status: 'running', currentStage: next });
      const refreshed = await repo.getPipeline(pipelineId);
      await startStage({ pipeline: refreshed, stage: next });
      return;
    }

    if (stage === 3) {
      const refreshed = await repo.getPipeline(pipelineId);
      return advanceFromStage3(refreshed);
    }

    if (stage === 5) {
      const overall = parseQaOverall(readStageOutput(fullPath));
      if (overall === 'pass') {
        await repo.updateStatus(pipelineId, { status: 'running', currentStage: 6 });
        const refreshed = await repo.getPipeline(pipelineId);
        await startStage({ pipeline: refreshed, stage: 6 });
      } else {
        await advanceToFixCycle(pipelineId, 'qa_failed');
      }
      return;
    }

    if (stage === 6) {
      const blockers = parseReviewBlockers(readStageOutput(fullPath));
      if (blockers === 0) {
        await repo.updateStatus(pipelineId, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
      } else {
        await advanceToFixCycle(pipelineId, 'review_blockers');
      }
      return;
    }
  }

  async function handleChunkSessionComplete({ pipeline, sessionId }) {
    const chunk = await repo.findChunkBySessionId(sessionId);
    if (!chunk) return; // session wasn't tied to a chunk

    if (chunk.status === 'completed') return; // already processed (defensive)
    await repo.markChunkCompleted(pipeline.id, chunk.chunk_index);
    await safeEndSession(sessionId);

    const next = await repo.getNextPendingChunk(pipeline.id);
    if (next) {
      const sessionResult = await startStage({
        pipeline,
        stage: 4,
        chunk: {
          index: next.chunk_index,
          name: next.name,
          body: next.body,
          files: next.files,
          qaScenarios: next.qa_scenarios,
          dependencies: next.dependencies,
          complexity: next.complexity,
        },
      });
      await repo.markChunkRunning(pipeline.id, next.chunk_index, sessionResult.sessionId);
      return;
    }

    // All chunks complete — advance to QA execution.
    await repo.updateStatus(pipeline.id, { status: 'running', currentStage: 5 });
    const refreshed = await repo.getPipeline(pipeline.id);
    await startStage({ pipeline: refreshed, stage: 5, iteration: 1 });
  }

  async function handleFixCycleComplete({ pipeline, sessionId }) {
    await safeEndSession(sessionId);
    // After a fix-cycle session ends, re-run QA execution.
    await repo.updateStatus(pipeline.id, { status: 'running', currentStage: 5 });
    const refreshed = await repo.getPipeline(pipeline.id);
    const cycleCount = refreshed.fix_cycle_count || 1;
    await startStage({ pipeline: refreshed, stage: 5, iteration: cycleCount + 1 });
  }

  async function advanceToFixCycle(pipelineId, reason) {
    const cycleCount = await repo.incrementFixCycleCount(pipelineId);
    if (cycleCount > FIX_CYCLE_CAP) {
      const lastQa = await repo.getLatestStageOutput(pipelineId, 5);
      const lastReview = await repo.getLatestStageOutput(pipelineId, 6);
      await repo.updateStatus(pipelineId, { status: 'paused_for_escalation' });
      await repo.createEscalation({
        pipelineId,
        stage: 7,
        summary: `Pipeline stuck after ${FIX_CYCLE_CAP} fix cycles (reason: ${reason}).`,
        detail: [
          `Latest QA report: ${lastQa?.output_path || 'none'}`,
          `Latest code review: ${lastReview?.output_path || 'none'}`,
          `The agent has tried ${FIX_CYCLE_CAP} fix cycles and the pipeline is still failing. ` +
            `Review the QA report and code review, then either retry manually with new guidance or abort.`,
        ].join('\n'),
      });
      return;
    }
    await repo.updateStatus(pipelineId, { status: 'running', currentStage: 7 });
    const refreshed = await repo.getPipeline(pipelineId);
    await startStage({ pipeline: refreshed, stage: 7, iteration: cycleCount });
  }

  async function approveCurrentStage(pipelineId) {
    const pipeline = await repo.getPipeline(pipelineId);
    if (!pipeline) throw new Error('Pipeline not found');
    if (pipeline.status !== 'paused_for_approval') {
      throw new Error(
        `Pipeline is in status "${pipeline.status}", not paused_for_approval`
      );
    }

    const stage = pipeline.current_stage;
    await repo.approveStageOutput(pipelineId, stage);

    const gatedSessionId = await repo.findActiveSessionForStage(pipelineId, stage);
    await safeEndSession(gatedSessionId);

    // For stages 5 and 6, the downstream branching (QA pass/fail, blocker count)
    // depends on the stage output file. Re-resolve the path the same way
    // handleSessionComplete did so proceedFromStage can read it.
    const outputPath = promptBuilder.outputPathFor(stage, pipeline.name);
    const projectRootPath = await getProjectRootPath(pipeline.project_id);
    const fullPath = path.join(projectRootPath, outputPath);

    await proceedFromStage(pipelineId, stage, fullPath);
  }

  async function advanceFromStage3(pipeline) {
    const projectRootPath = await getProjectRootPath(pipeline.project_id);
    const buildPlanRel = promptBuilder.outputPathFor(3, pipeline.name);
    const buildPlanFull = path.join(projectRootPath, buildPlanRel);

    let chunks;
    try {
      const buildPlanText = readBuildPlan(buildPlanFull);
      chunks = parseBuildPlan(buildPlanText);
    } catch (err) {
      await repo.updateStatus(pipeline.id, { status: 'paused_for_failure' });
      await repo.createEscalation({
        pipelineId: pipeline.id,
        stage: 4,
        summary: 'Could not parse the build plan into chunks.',
        detail: `Error: ${err.message}\nBuild plan: ${buildPlanRel}`,
      });
      return;
    }

    await repo.createChunks(pipeline.id, chunks);
    await repo.updateStatus(pipeline.id, { status: 'running', currentStage: 4 });
    const refreshed = await repo.getPipeline(pipeline.id);
    const firstChunk = chunks[0];
    const sessionResult = await startStage({
      pipeline: refreshed,
      stage: 4,
      chunk: firstChunk,
    });
    await repo.markChunkRunning(pipeline.id, firstChunk.index, sessionResult.sessionId);
  }

  async function rejectCurrentStage(pipelineId, feedback) {
    if (!feedback || !String(feedback).trim()) {
      throw new Error('Rejection feedback is required');
    }

    const pipeline = await repo.getPipeline(pipelineId);
    if (!pipeline) throw new Error('Pipeline not found');
    if (pipeline.status !== 'paused_for_approval') {
      throw new Error(
        `Pipeline is in status "${pipeline.status}", not paused_for_approval`
      );
    }

    const stage = pipeline.current_stage;
    await repo.rejectStageOutput(pipelineId, stage);

    const rejectedSessionId = await repo.findActiveSessionForStage(pipelineId, stage);
    await safeEndSession(rejectedSessionId);

    await repo.updateStatus(pipelineId, { status: 'running' });
    await startStage({ pipeline, stage, rejectionFeedback: feedback });
  }

  return {
    createAndStart,
    handleSessionComplete,
    approveCurrentStage,
    rejectCurrentStage,
    _internal: { startStage, retryAttempts },
  };
}

function parseQaOverall(reportText) {
  if (!reportText) return 'fail';
  const lines = reportText.split('\n').map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-10);
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i].match(/^Overall:\s*(pass|fail)\b/i);
    if (m) return m[1].toLowerCase();
  }
  return 'fail';
}

function parseReviewBlockers(reportText) {
  if (!reportText) return Number.MAX_SAFE_INTEGER;
  const lines = reportText.split('\n').map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-10);
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i].match(/^Blockers:\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  return Number.MAX_SAFE_INTEGER;
}

module.exports = {
  create,
  FIX_CYCLE_CAP,
  _parseQaOverall: parseQaOverall,
  _parseReviewBlockers: parseReviewBlockers,
};
