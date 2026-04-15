/**
 * Eval Reporter — composes human-readable failure messages from eval results.
 */

import path from 'path';

/**
 * Safely parse a judge verdict — may be an object, a JSON string, or malformed.
 * Returns the parsed object, or null if unparseable.
 */
function safeParseVerdict(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/**
 * Compose a failure message from eval results, history, and summary.
 *
 * @param {object[]} results - Array of eval run results
 * @param {object[]} history - Array of recent eval_runs rows (eval_name, state, commit_sha)
 * @param {object} summary - { total, passed, failed, errors }
 * @returns {string} Formatted failure message
 */
export function composeFailureMessage(results, history, summary) {
  const lines = [];

  // Header
  lines.push(`Eval run complete: ${summary.total} evals ran, ${summary.failed} failed, ${summary.errors} errors.`);
  lines.push('');

  // Group results by state
  const passed = results.filter(r => r.state === 'pass');
  const failed = results.filter(r => r.state === 'fail');
  const errors = results.filter(r => r.state === 'error');

  // Identify low-confidence passes — spec requires these to be flagged in the message
  const lowConfPasses = passed.filter(r => {
    const v = safeParseVerdict(r.judgeVerdict);
    return v && v.confidence === 'low';
  });

  // PASSED
  for (const r of passed) {
    const folder = r.evalFolder ? path.basename(r.evalFolder) + '/' : '';
    const isLowConf = lowConfPasses.includes(r);
    lines.push(`PASSED${isLowConf ? ' (LOW CONFIDENCE)' : ''}: ${r.evalName} (${folder})`);
  }
  if (passed.length > 0) lines.push('');

  // LOW-CONFIDENCE PASS DETAILS — spec: amber-flagged passes must be called out
  if (lowConfPasses.length > 0) {
    lines.push('LOW-CONFIDENCE PASSES — verify these results:');
    for (const r of lowConfPasses) {
      const folder = r.evalFolder ? path.basename(r.evalFolder) + '/' : '';
      const v = safeParseVerdict(r.judgeVerdict);
      lines.push(`  ${r.evalName} (${folder})`);
      if (v.reasoning) {
        lines.push(`    Judge reasoning: "${v.reasoning}"`);
      }
      lines.push(`    Note: Judge confidence was low — verify before trusting this pass.`);
    }
    lines.push('');
  }

  // FAILED
  for (const r of failed) {
    const folder = r.evalFolder ? path.basename(r.evalFolder) + '/' : '';
    lines.push(`FAILED: ${r.evalName} (${folder})`);

    // Show the human-readable expected outcome from the eval definition
    if (r.expected) {
      lines.push(`  Expected: ${r.expected}`);
    }

    // Check if this was a check failure (no judge invoked)
    if (r.checkFailures && r.checkFailures.length > 0) {
      const failedChecks = r.checkFailures.map(f => `${f.type}: ${f.reason}`).join('; ');
      lines.push(`  Check failure: ${failedChecks}`);
      lines.push(`  (Judge was not invoked — structural check failed)`);
    }

    if (r.evidence) {
      const evidenceStr = typeof r.evidence === 'string' ? r.evidence : JSON.stringify(r.evidence);
      const truncated = evidenceStr.length > 200 ? evidenceStr.slice(0, 200) + '...' : evidenceStr;
      lines.push(`  Evidence: ${truncated}`);
    }

    if (r.judgeVerdict) {
      const verdict = safeParseVerdict(r.judgeVerdict);
      if (verdict && verdict.reasoning) {
        lines.push(`  Judge reasoning: "${verdict.reasoning}"`);
      }
      if (verdict && verdict.confidence !== undefined) {
        lines.push(`  Confidence: ${verdict.confidence}`);
        if (verdict.confidence === 'low') {
          lines.push(`  Note: Judge confidence was low — verify before acting on this result.`);
        }
      }
    }

    lines.push('');
  }

  // ERRORS
  for (const r of errors) {
    const folder = r.evalFolder ? path.basename(r.evalFolder) + '/' : '';
    lines.push(`ERROR: ${r.evalName} (${folder})`);
    lines.push(`  ${r.error || 'Unknown error'}`);
    lines.push(`  (Infrastructure issue, not a regression)`);
    lines.push('');
  }

  // History section
  if (history && history.length > 0) {
    lines.push('LAST 3 RUNS:');
    const byName = new Map();
    for (const h of history) {
      if (!byName.has(h.eval_name)) byName.set(h.eval_name, []);
      byName.get(h.eval_name).push(h);
    }

    for (const [evalName, runs] of byName) {
      // runs are in DESC order from DB, reverse for chronological display
      const chronological = [...runs].reverse();
      const parts = chronological.map(r => {
        const sha = r.commit_sha || '???';
        return `${r.state.toUpperCase()} ${sha}`;
      });
      lines.push(`  ${evalName}:    ${parts.join(' → ')}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
