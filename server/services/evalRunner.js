/**
 * Eval Runner — orchestrates evidence gathering, checks, and judge evaluation.
 */

import { gatherEvidence } from './evidenceGatherers.js';
import { runAllChecks } from './evalChecks.js';
import { callJudge } from './evalJudge.js';

/**
 * Run a single eval definition through the full pipeline:
 *   gather evidence -> empty check -> run checks -> call judge -> record verdict
 *
 * @param {object} evalDef - Parsed eval definition
 * @param {object} context - Execution context
 * @returns {Promise<object>} Eval result
 */
export async function runSingleEval(evalDef, context) {
  const startTime = Date.now();
  const result = {
    evalName: evalDef.name,
    state: null,
    error: null,
    failReason: null,
    evidence: null,
    checkResults: null,
    checkFailures: null,
    judgeVerdict: null,
    duration: null,
    timestamp: new Date().toISOString(),
  };

  // Step 1: Gather evidence
  let evidence;
  try {
    evidence = await gatherEvidence(evalDef.evidence, context);
    result.evidence = evidence;
  } catch (err) {
    result.state = 'error';
    result.error = `Evidence gathering failed: ${err.message}`;
    result.duration = Date.now() - startTime;
    return result;
  }

  // Step 2: Empty evidence check — spec nests allow_empty under evidence:
  const allowEmpty = evalDef.evidence && evalDef.evidence.allow_empty;
  if ((!evidence || String(evidence).trim().length === 0) && !allowEmpty) {
    result.state = 'fail';
    result.failReason = 'no evidence gathered';
    result.duration = Date.now() - startTime;
    return result;
  }

  // Step 3: Run deterministic checks
  if (evalDef.checks && evalDef.checks.length > 0) {
    const checkResult = runAllChecks(evalDef.checks, evidence);
    result.checkResults = checkResult.results;
    result.checkFailures = checkResult.failures;

    if (!checkResult.allPassed) {
      result.state = 'fail';
      result.failReason = checkResult.failures
        .map((f) => `${f.type}: ${f.reason}`)
        .join('; ');
      result.duration = Date.now() - startTime;
      return result;
    }
  }

  // Step 4: If no judge_prompt, this is a deterministic-only eval — pass
  if (!evalDef.judge_prompt) {
    result.state = 'pass';
    result.duration = Date.now() - startTime;
    return result;
  }

  // Step 5: Call judge
  let verdict;
  try {
    verdict = await callJudge({
      expected: evalDef.expected,
      evidence,
      judgePrompt: evalDef.judge_prompt,
      model: evalDef.model,
    });
    result.judgeVerdict = verdict;
  } catch (err) {
    result.state = 'error';
    result.error = `Judge call failed: ${err.message}`;
    result.duration = Date.now() - startTime;
    return result;
  }

  // Step 6: Handle judge parse errors
  if (verdict.error || verdict.result === null) {
    result.state = 'error';
    result.error = verdict.error || 'Judge returned null result';
    result.duration = Date.now() - startTime;
    return result;
  }

  // Step 7: Record verdict
  result.state = verdict.result; // 'pass' or 'fail'
  result.duration = Date.now() - startTime;
  return result;
}

/**
 * Run a batch of evals in parallel.
 * @param {object[]} evals - Array of parsed eval definitions
 * @param {object} context - Execution context
 * @returns {Promise<object[]>} Array of eval results
 */
export async function runEvalBatch(evals, context) {
  return Promise.all(evals.map((evalDef) => runSingleEval(evalDef, context)));
}
