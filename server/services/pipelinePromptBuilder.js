const NO_SUBAGENT_INSTRUCTION = `Do not spawn sub-agents, background processes, or parallel tasks on your own. If you need work done in parallel, if a task is too large for a single session, or if you need a different perspective (planning, QA, code review), use the Mission Control MCP tools to start a new session. All work must be visible in Mission Control. Starting your own sub-agents outside of Mission Control is not allowed.`;

function slugForOutput(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'unnamed';
}

function outputPathFor(stage, pipelineNameOrSlug) {
  const slug = slugForOutput(pipelineNameOrSlug);
  if (stage === 1) return `docs/specs/${slug}-refined.md`;
  if (stage === 2) return `docs/specs/${slug}-qa-plan.md`;
  if (stage === 3) return `docs/specs/${slug}-build-plan.md`;
  throw new Error(`Unknown stage: ${stage}`);
}

function buildStagePrompt({ stagePrompt, rejectionFeedback }) {
  const parts = [stagePrompt.trim(), '', `## Global rules`, NO_SUBAGENT_INSTRUCTION];
  if (rejectionFeedback) {
    parts.push('', '## Previous attempt rejected');
    parts.push('Your previous output was rejected by the project owner. Here is the feedback:');
    parts.push('');
    parts.push(rejectionFeedback);
    parts.push('');
    parts.push('Revise your output to address this feedback. Re-read the spec and the inputs before producing the new output.');
  }
  return parts.join('\n');
}

function buildStageTask({ stage, pipelineName, specInput, refinedSpecPath, qaPlanPath, outputPath }) {
  if (stage === 1) {
    return [
      `# Pipeline: ${pipelineName} — Stage 1: Spec Refinement`,
      '',
      `## Raw spec from the user`,
      '',
      specInput,
      '',
      `## Output`,
      '',
      `Write the refined spec to: ${outputPath}`,
      '',
      `When the file is written, exit. The pipeline will detect the file and advance.`,
    ].join('\n');
  }
  if (stage === 2) {
    return [
      `# Pipeline: ${pipelineName} — Stage 2: QA Design`,
      '',
      `## Inputs`,
      '',
      `Refined spec: ${refinedSpecPath}`,
      '',
      `Read the refined spec, then design the QA plan.`,
      '',
      `## Output`,
      '',
      `Write the QA plan to: ${outputPath}`,
      '',
      `When the file is written, exit.`,
    ].join('\n');
  }
  if (stage === 3) {
    return [
      `# Pipeline: ${pipelineName} — Stage 3: Implementation Planning`,
      '',
      `## Inputs`,
      '',
      `Refined spec: ${refinedSpecPath}`,
      `QA plan: ${qaPlanPath}`,
      '',
      `Read both. Then break the work into ordered, dependency-aware chunks.`,
      '',
      `## Output`,
      '',
      `Write the build plan to: ${outputPath}`,
      '',
      `When the file is written, exit.`,
    ].join('\n');
  }
  throw new Error(`Unknown stage: ${stage}`);
}

const SESSION_TYPE_BY_STAGE = {
  1: 'spec_refinement',
  2: 'qa_design',
  3: 'implementation_planning',
};

function sessionTypeForStage(stage) {
  return SESSION_TYPE_BY_STAGE[stage];
}

module.exports = {
  NO_SUBAGENT_INSTRUCTION,
  outputPathFor,
  buildStagePrompt,
  buildStageTask,
  sessionTypeForStage,
};
