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
  if (stage === 4) return null; // stage 4 produces code commits, not a doc
  if (stage === 5) return `docs/specs/${slug}-qa-report.md`;
  if (stage === 6) return `docs/specs/${slug}-code-review.md`;
  if (stage === 7) return null; // fix cycle produces code commits, not a doc
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

function buildStageTask(opts) {
  const {
    stage,
    pipelineName,
    specInput,
    refinedSpecPath,
    qaPlanPath,
    qaReportPath,
    codeReviewPath,
    outputPath,
    chunk,
    iteration,
  } = opts;

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
      `Read both. Then break the work into ordered, dependency-aware chunks. Use the exact chunk format described in your stage instructions — the orchestrator parses it programmatically.`,
      '',
      `## Output`,
      '',
      `Write the build plan to: ${outputPath}`,
      '',
      `When the file is written, exit.`,
    ].join('\n');
  }
  if (stage === 4) {
    if (!chunk) throw new Error('stage 4 requires a chunk');
    const chunkHeader = `Chunk ${chunk.index}: ${chunk.name}`;
    return [
      `# Pipeline: ${pipelineName} — Stage 4: Implementation`,
      '',
      `## Context`,
      '',
      `You are implementing one chunk of a larger build plan. The full refined spec is at \`${refinedSpecPath}\` and the QA plan is at \`${qaPlanPath}\` — read both before you start. Your scope is only the chunk below.`,
      '',
      `## ${chunkHeader}`,
      '',
      chunk.files ? `**Files in scope:** ${chunk.files}` : '',
      chunk.qaScenarios ? `**QA scenarios this chunk must satisfy:** ${chunk.qaScenarios}` : '',
      chunk.dependencies ? `**Depends on:** ${chunk.dependencies}` : '',
      chunk.complexity ? `**Complexity estimate:** ${chunk.complexity}` : '',
      '',
      `### What to build`,
      '',
      chunk.body || '',
      '',
      `## Output`,
      '',
      `Commit your changes on the pipeline branch. The pipeline detects completion when your session ends; the next chunk (or the QA stage) will start automatically.`,
    ].filter((line) => line !== '').join('\n');
  }
  if (stage === 5) {
    return [
      `# Pipeline: ${pipelineName} — Stage 5: QA Execution${iteration && iteration > 1 ? ` (iteration ${iteration})` : ''}`,
      '',
      `## Inputs`,
      '',
      `Refined spec: ${refinedSpecPath}`,
      `QA plan: ${qaPlanPath}`,
      '',
      `Run every scenario in the QA plan against the implementation that was just shipped on this branch.`,
      '',
      `## Output`,
      '',
      `Write the QA report to: ${outputPath}`,
      '',
      `The very last line of the file MUST be exactly one of:`,
      `- \`Overall: pass\``,
      `- \`Overall: fail\``,
      '',
      `When the file is written, exit. The pipeline parses that final line to decide what to do next.`,
    ].join('\n');
  }
  if (stage === 6) {
    return [
      `# Pipeline: ${pipelineName} — Stage 6: Code Review`,
      '',
      `## Inputs`,
      '',
      `Refined spec: ${refinedSpecPath}`,
      `QA report: ${qaReportPath}`,
      '',
      `Review the diff that the implementation stage produced on this branch (compare against \`main\`).`,
      '',
      `## Output`,
      '',
      `Write the code review to: ${outputPath}`,
      '',
      `The very last line of the file MUST be exactly one of:`,
      `- \`Blockers: 0\` — pipeline completes`,
      `- \`Blockers: N\` — N blocker findings; pipeline triggers the fix cycle`,
      '',
      `When the file is written, exit.`,
    ].join('\n');
  }
  if (stage === 7) {
    return [
      `# Pipeline: ${pipelineName} — Stage 7: Fix Cycle (iteration ${iteration || 1})`,
      '',
      `## Inputs`,
      '',
      `Refined spec: ${refinedSpecPath}`,
      `QA report (with failures to fix): ${qaReportPath}`,
      codeReviewPath ? `Code review (with blockers to fix): ${codeReviewPath}` : '',
      '',
      `Address every QA failure and code review blocker. Do not refactor unrelated code. Do not handle Concerns or Suggestions in this cycle.`,
      '',
      `## Output`,
      '',
      `Commit fixes on the pipeline branch. The pipeline detects completion when your session ends and re-runs QA.`,
    ].filter((line) => line !== '').join('\n');
  }
  throw new Error(`Unknown stage: ${stage}`);
}

const SESSION_TYPE_BY_STAGE = {
  1: 'spec_refinement',
  2: 'qa_design',
  3: 'implementation_planning',
  4: 'implementation',
  5: 'qa_execution',
  6: 'code_review',
  7: 'implementation', // fix cycle is implementation work
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
