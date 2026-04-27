const path = require('path');
const repo = require('./pipelineRepo');
const promptBuilder = require('./pipelinePromptBuilder');
const { query } = require('../database');

// Module-level retry tracking. Keyed by `${pipelineId}:${stage}`.
// Each test creates fresh pipeline IDs so keys won't collide across test cases.
const retryAttempts = new Map();

function create(deps) {
  if (!deps || !deps.createBranch || !deps.startSession || !deps.readFileExists) {
    throw new Error(
      'pipelineOrchestrator.create requires deps: createBranch, startSession, readFileExists'
    );
  }

  async function getProjectRootPath(projectId) {
    const r = await query('SELECT root_path FROM projects WHERE id = $1', [projectId]);
    if (!r.rows[0]) throw new Error(`Project not found: ${projectId}`);
    return r.rows[0].root_path;
  }

  async function startStage({ pipeline, stage, rejectionFeedback }) {
    const prompts = await repo.getStagePrompts(pipeline.id);
    const stagePrompt = prompts[String(stage)];
    if (!stagePrompt) throw new Error(`No prompt for stage ${stage}`);

    const systemPrompt = promptBuilder.buildStagePrompt({
      stagePrompt,
      rejectionFeedback: rejectionFeedback || null,
    });
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
        refinedSpecPath: promptBuilder.outputPathFor(1, pipeline.name),
        outputPath,
      });
    } else if (stage === 3) {
      task = promptBuilder.buildStageTask({
        stage: 3,
        pipelineName: pipeline.name,
        refinedSpecPath: promptBuilder.outputPathFor(1, pipeline.name),
        qaPlanPath: promptBuilder.outputPathFor(2, pipeline.name),
        outputPath,
      });
    } else {
      throw new Error(`Stage ${stage} not supported in Phase 1`);
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
    });
  }

  async function createAndStart({ projectId, name, specInput }) {
    const active = await repo.getActivePipelineForProject(projectId);
    if (active) {
      throw new Error(
        `Project already has an active pipeline (${active.id} — "${active.name}"). ` +
          `Wait for it to complete before starting a new one.`
      );
    }

    const projectRootPath = await getProjectRootPath(projectId);
    const pipeline = await repo.createPipeline({ projectId, name, specInput });

    await deps.createBranch({ branchName: pipeline.branch_name, projectRootPath });
    await repo.updateStatus(pipeline.id, { status: 'running', currentStage: 1 });
    await startStage({ pipeline, stage: 1 });

    return repo.getPipeline(pipeline.id);
  }

  async function handleSessionComplete({ sessionId, pipelineId, pipelineStage }) {
    if (!pipelineId) return;

    const pipeline = await repo.getPipeline(pipelineId);
    if (!pipeline) return;
    if (pipeline.status === 'completed' || pipeline.status === 'failed') return;

    const outputPath = promptBuilder.outputPathFor(pipelineStage, pipeline.name);
    const projectRootPath = await getProjectRootPath(pipeline.project_id);
    const fullPath = path.join(projectRootPath, outputPath);
    const exists = deps.readFileExists(fullPath);

    if (!exists) {
      const retryKey = `${pipelineId}:${pipelineStage}`;
      const attempts = retryAttempts.get(retryKey) || 0;

      if (attempts === 0) {
        // First failure — retry once with guidance.
        retryAttempts.set(retryKey, 1);
        await startStage({
          pipeline,
          stage: pipelineStage,
          rejectionFeedback:
            'Your previous attempt did not produce the expected output file. ' +
            'Make sure to actually write the file at the path specified in the task before exiting.',
        });
        return;
      }

      // Second failure — escalate to paused_for_failure.
      retryAttempts.delete(retryKey);
      await repo.updateStatus(pipelineId, { status: 'paused_for_failure' });
      return;
    }

    // Output file exists — clear any retry state and record the output.
    retryAttempts.delete(`${pipelineId}:${pipelineStage}`);

    const existingOutputs = await repo.listStageOutputs(pipelineId);
    const sameStage = existingOutputs.filter((o) => o.stage === pipelineStage);
    const iteration = sameStage.length + 1;

    await repo.recordStageOutput({ pipelineId, stage: pipelineStage, iteration, outputPath });

    // All stages in Phase 1 are approval-gated.
    await repo.updateStatus(pipelineId, { status: 'paused_for_approval' });
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

    if (stage >= 3) {
      // Phase 1 ends after stage 3 approval.
      await repo.updateStatus(pipelineId, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      return;
    }

    const nextStage = stage + 1;
    await repo.updateStatus(pipelineId, { status: 'running', currentStage: nextStage });

    const refreshed = await repo.getPipeline(pipelineId);
    await startStage({ pipeline: refreshed, stage: nextStage });
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

module.exports = { create };
