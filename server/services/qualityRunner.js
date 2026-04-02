/**
 * Server-side quality check runner.
 *
 * Claude Code's --print mode doesn't fire PostToolUse or Stop hooks,
 * so Mission Control runs quality checks itself using the Anthropic SDK.
 * It watches stream events for tool_use and result events, then runs
 * the matching quality rule prompts against the API.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { query } = require('../database');

const anthropic = new Anthropic();

// Cache rules to avoid DB queries on every tool use
let rulesCache = null;
let rulesCacheTime = 0;
const CACHE_TTL = 30000; // 30s

async function getEnabledRules() {
  const now = Date.now();
  if (rulesCache && now - rulesCacheTime < CACHE_TTL) return rulesCache;
  const { rows } = await query('SELECT * FROM quality_rules WHERE enabled = 1 ORDER BY sort_order');
  rulesCache = rows;
  rulesCacheTime = now;
  return rows;
}

// Invalidate cache when rules change
function invalidateRulesCache() {
  rulesCache = null;
}

// Map Claude Code tool names to hook matchers
function toolMatchesMatcher(toolName, matcher) {
  if (!matcher) return true;
  // Direct match
  if (toolName === matcher) return true;
  // Write matcher also matches Edit (both modify files)
  if (matcher === 'Write' && toolName === 'Edit') return true;
  return false;
}

/**
 * Search for a spec document in common locations relative to a working directory.
 * Returns { found: boolean, path: string|null, content: string|null }
 */
function findSpecFile(cwd) {
  if (!cwd) return { found: false, path: null, content: null };

  const candidates = [
    path.join(cwd, 'spec.md'),
    path.join(cwd, 'SPEC.md'),
    path.join(cwd, 'docs', 'spec.md'),
    path.join(cwd, '.claude', 'spec.md'),
    path.join(cwd, '.claude', 'SPEC.md'),
  ];

  // Also check for *.spec.md and specs/*.md via glob-like search
  try {
    const files = fs.readdirSync(cwd);
    for (const f of files) {
      if (f.endsWith('.spec.md')) {
        candidates.unshift(path.join(cwd, f));
      }
    }
    const specsDir = path.join(cwd, 'specs');
    if (fs.existsSync(specsDir) && fs.statSync(specsDir).isDirectory()) {
      const specFiles = fs.readdirSync(specsDir);
      for (const f of specFiles) {
        if (f.endsWith('.md')) {
          candidates.push(path.join(specsDir, f));
        }
      }
    }
  } catch (e) {
    // Ignore read errors
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf-8');
        return { found: true, path: candidate, content };
      }
    } catch (e) {
      // Skip unreadable files
    }
  }

  return { found: false, path: null, content: null };
}

/**
 * Run a quality check prompt via the Anthropic SDK.
 * Returns { result: 'pass'|'fail', details: string|null, analysis: string|null }
 */
async function runQualityCheck(rule, context) {
  try {
    const prompt = `${rule.prompt}

Context about what just happened:
${context}

IMPORTANT: After your evaluation, report the result by including one of these markers at the very end of your response:
QUALITY_RESULT:${rule.id}:${rule.severity}:PASS
or
QUALITY_RESULT:${rule.id}:${rule.severity}:FAIL:[brief reason]`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: 'You are a code quality reviewer. Be concise. Evaluate the code change and report PASS or FAIL with the exact QUALITY_RESULT marker format requested.',
      messages: [{ role: 'user', content: prompt }],
    });

    const fullText = response.content[0]?.text || '';
    // Strip the QUALITY_RESULT marker line from the analysis text
    const analysis = fullText.replace(/QUALITY_RESULT:\S+:\w+:(?:PASS|FAIL)(?::.*)?/g, '').trim();
    const match = fullText.match(/QUALITY_RESULT:(\S+):(\w+):(PASS|FAIL)(?::(.*))?/);
    if (match) {
      const [, , , result, details] = match;
      return { result: result.toLowerCase(), details: details || null, analysis };
    }
    return { result: 'pass', details: 'Quality check completed (no explicit marker)', analysis };
  } catch (e) {
    console.error(`[QualityRunner] Error running check ${rule.id}:`, e.message);
    return null; // Skip on error
  }
}

/**
 * Run spec-compliance check with the actual spec document content.
 * Uses a more thorough prompt that includes the spec text.
 * Returns { result: 'pass'|'fail', details: string|null, analysis: string|null }
 */
async function runSpecComplianceCheck(rule, specContent, specPath, conversationContext) {
  try {
    const prompt = `You are a strict spec compliance reviewer. A spec document is attached below.

## Spec Document (from ${specPath})
${specContent}

## Recent Conversation Context
${conversationContext}

## Your Task
Enumerate EVERY requirement from the spec document above. For each one, determine whether it is:
- Fully implemented
- Partially implemented (explain what's missing)
- Missing entirely

Create a detailed checklist:
- [x] Requirement description (fully done)
- [ ] Requirement description (what's missing or incomplete)

If ALL requirements are fully met, respond with:
QUALITY_RESULT:${rule.id}:${rule.severity}:PASS

If ANY requirements are missing or incomplete, respond with a detailed list of what's unfinished, then:
QUALITY_RESULT:${rule.id}:${rule.severity}:FAIL:[count] requirements incomplete`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: 'You are a strict spec compliance reviewer. Be thorough — enumerate every requirement from the spec and check each one. Do not give the benefit of the doubt. If you cannot confirm a requirement was implemented from the conversation context, mark it incomplete.',
      messages: [{ role: 'user', content: prompt }],
    });

    const fullText = response.content[0]?.text || '';
    const analysis = fullText.replace(/QUALITY_RESULT:\S+:\w+:(?:PASS|FAIL)(?::.*)?/g, '').trim();
    const match = fullText.match(/QUALITY_RESULT:(\S+):(\w+):(PASS|FAIL)(?::(.*))?/);
    if (match) {
      const [, , , result, details] = match;
      return { result: result.toLowerCase(), details: details || null, analysis };
    }
    return { result: 'pass', details: 'Spec check completed (no explicit marker)', analysis };
  } catch (e) {
    console.error(`[QualityRunner] Error running spec compliance check:`, e.message);
    return null;
  }
}

/**
 * Save a quality result to DB and broadcast to session listeners.
 */
async function saveAndBroadcast(sessionId, rule, result, broadcast) {
  await query(
    `INSERT INTO quality_results (session_id, rule_id, rule_name, result, severity, details, timestamp) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [sessionId, rule.id, rule.name, result.result, rule.severity, result.details]
  ).catch(e => console.error('[QualityRunner] DB error:', e.message));

  console.log(`[QualityRunner] ${rule.id}: ${result.result.toUpperCase()} for session ${sessionId.slice(0, 8)}`);

  if (broadcast) {
    broadcast({
      type: 'quality_result',
      sessionId,
      ruleId: rule.id,
      ruleName: rule.name,
      result: result.result,
      severity: rule.severity,
      details: result.details,
      analysis: result.analysis || null,
      trigger: rule.fires_on,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Handle a tool_use event — run matching PostToolUse quality rules.
 * Runs async in the background so it doesn't block the stream.
 */
async function onToolUse(sessionId, toolName, toolInput, broadcast) {
  const rules = await getEnabledRules();
  const postToolRules = rules.filter(r => {
    const triggers = r.fires_on.split(',').map(s => s.trim());
    return triggers.some(t => {
      const [event, matcher] = t.split(':');
      return event === 'PostToolUse' && toolMatchesMatcher(toolName, matcher);
    });
  });

  if (postToolRules.length === 0) return;

  // Build context from tool use
  const context = `Tool used: ${toolName}\nInput: ${JSON.stringify(toolInput).slice(0, 1000)}`;

  for (const rule of postToolRules) {
    if (rule.hook_type === 'command') continue;

    const result = await runQualityCheck(rule, context);
    if (result) {
      await saveAndBroadcast(sessionId, rule, result, broadcast);
    }
  }
}

/**
 * Handle session completion — run Stop quality rules.
 *
 * Returns an array of failures that have send_fail_to_agent enabled.
 * Each entry: { ruleId, ruleName, analysis, details, specPath? }
 * The caller (sessionManager) sends these back to the agent as messages.
 */
async function onSessionStop(sessionId, broadcast) {
  const rules = await getEnabledRules();
  const stopRules = rules.filter(r => {
    const triggers = r.fires_on.split(',').map(s => s.trim());
    return triggers.some(t => t === 'Stop');
  });

  if (stopRules.length === 0) return [];

  // Get session working directory
  const { rows: sessionRows } = await query(
    'SELECT working_directory FROM sessions WHERE id = $1',
    [sessionId]
  );
  const cwd = sessionRows[0]?.working_directory || null;

  // Check for spec file (used by spec-compliance for enhanced checking)
  const spec = findSpecFile(cwd);

  // Get recent session messages for context
  const { rows: messages } = await query(
    'SELECT role, content FROM messages WHERE session_id = $1 ORDER BY timestamp DESC LIMIT 20',
    [sessionId]
  );
  const context = messages.reverse()
    .map(m => `${m.role}: ${m.content?.slice(0, 300) || ''}`)
    .join('\n\n');

  const failuresToSend = [];

  for (const rule of stopRules) {
    if (rule.hook_type === 'command') continue;

    let result;

    // For spec-compliance with a real spec file, use the enhanced check
    if (rule.id === 'spec-compliance' && spec.found) {
      console.log(`[QualityRunner] Spec file found at ${spec.path} — running enforcement-mode check`);
      result = await runSpecComplianceCheck(rule, spec.content, spec.path, context);
    } else {
      result = await runQualityCheck(rule, context);
    }

    if (result) {
      await saveAndBroadcast(sessionId, rule, result, broadcast);

      // Collect failures for rules with send_fail_to_agent enabled
      if (result.result === 'fail' && rule.send_fail_to_agent) {
        // If requires_spec is set, only send when a spec file is present
        if (rule.send_fail_requires_spec && !spec.found) {
          console.log(`[QualityRunner] Rule "${rule.name}" failed but no spec found — skipping send to agent`);
        } else {
          console.log(`[QualityRunner] Rule "${rule.name}" failed with send_fail_to_agent — will message agent`);
          failuresToSend.push({
            ruleId: rule.id,
            ruleName: rule.name,
            analysis: result.analysis,
            details: result.details,
            specPath: spec.found ? spec.path : null,
          });
        }
      }
    }
  }

  return failuresToSend;
}

module.exports = { onToolUse, onSessionStop, invalidateRulesCache };
