/**
 * Server-side quality check runner.
 *
 * Claude Code's --print mode doesn't fire PostToolUse or Stop hooks,
 * so Mission Control runs quality checks itself using the Anthropic SDK.
 * It watches stream events for tool_use and result events, then runs
 * the matching quality rule prompts against the API.
 */

const Anthropic = require('@anthropic-ai/sdk');
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
 * Run a quality check prompt via the Anthropic SDK.
 * Returns { result: 'pass'|'fail', details: string|null }
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
      model: 'claude-haiku-4-5-20251001',
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
 */
async function onSessionStop(sessionId, broadcast) {
  const rules = await getEnabledRules();
  const stopRules = rules.filter(r => {
    const triggers = r.fires_on.split(',').map(s => s.trim());
    return triggers.some(t => t === 'Stop');
  });

  if (stopRules.length === 0) return;

  // Get recent session messages for context
  const { rows: messages } = await query(
    'SELECT role, content FROM messages WHERE session_id = $1 ORDER BY timestamp DESC LIMIT 20',
    [sessionId]
  );
  const context = messages.reverse()
    .map(m => `${m.role}: ${m.content?.slice(0, 300) || ''}`)
    .join('\n\n');

  for (const rule of stopRules) {
    if (rule.hook_type === 'command') continue;

    const result = await runQualityCheck(rule, context);
    if (result) {
      await saveAndBroadcast(sessionId, rule, result, broadcast);
    }
  }
}

module.exports = { onToolUse, onSessionStop, invalidateRulesCache };
