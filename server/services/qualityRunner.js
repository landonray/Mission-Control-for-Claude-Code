/**
 * Server-side quality check runner.
 *
 * Claude Code's --print mode doesn't fire PostToolUse or Stop hooks,
 * so Mission Control runs quality checks itself using the LLM Gateway.
 * It watches stream events for tool_use and result events, then runs
 * the matching quality rule prompts against the API.
 */

const { chatCompletion } = require('./llmGateway');
const { MODEL_ROLES } = require('../config/models');
const { run: cliRun } = require('./cliAgent');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { query } = require('../database');
const mergeFields = require('./mergeFields');

// Cache rules to avoid DB queries on every tool use
let rulesCache = null;
let rulesCacheTime = 0;
const CACHE_TTL = 30000; // 30s

// Track currently-running quality checks per session so the UI can restore spinners on reload
// Map<sessionId, Map<ruleId, { ruleId, ruleName, severity, trigger, timestamp }>>
const runningChecks = new Map();

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
 * Search for a spec/document in session message attachments.
 * Checks for non-image file attachments uploaded through the chat UI.
 * Returns { found: boolean, path: string|null, content: string|null }
 */
async function findSpecFromAttachments(sessionId) {
  const { rows } = await query(
    'SELECT attachments FROM messages WHERE session_id = $1 AND attachments IS NOT NULL ORDER BY timestamp ASC',
    [sessionId]
  );

  const uploadsDir = path.join(__dirname, '..', '..', 'uploads');

  for (const row of rows) {
    let attachments;
    try {
      attachments = JSON.parse(row.attachments);
    } catch {
      continue;
    }
    if (!Array.isArray(attachments)) continue;

    for (const att of attachments) {
      // Skip images — we're looking for document attachments
      if (att.isImage) continue;

      const filePath = path.join(uploadsDir, att.filename);
      try {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8');
          return { found: true, path: att.originalName || att.filename, content };
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  return { found: false, path: null, content: null };
}

/**
 * Gather git context from the session's working directory.
 * Returns recent commits and the diff of the last commit.
 */
function getGitContext(cwd) {
  if (!cwd) return '';

  return new Promise((resolve) => {
    const parts = [];

    // Get recent commits
    execFile('git', ['log', '--oneline', '-10'], { cwd, timeout: 5000 }, (err, stdout) => {
      if (!err && stdout) parts.push(`## Recent Commits\n${stdout.trim()}`);

      // Get diff of the most recent commit
      execFile('git', ['diff', 'HEAD~1..HEAD', '--stat'], { cwd, timeout: 5000 }, (err2, stdout2) => {
        if (!err2 && stdout2) parts.push(`## Last Commit Diff (stat)\n${stdout2.trim()}`);

        // Get the actual last commit message + hash for verification
        execFile('git', ['log', '-1', '--format=%H %s'], { cwd, timeout: 5000 }, (err3, stdout3) => {
          if (!err3 && stdout3) parts.push(`## Last Commit\n${stdout3.trim()}`);

          resolve(parts.length > 0 ? `\n\n## Git State\n${parts.join('\n\n')}` : '');
        });
      });
    });
  });
}

/**
 * Parse allowed tools from a rule's config JSON.
 * Returns an array of tool names, or empty array if none specified.
 */
function getAllowedTools(rule) {
  if (!rule.config) return [];
  try {
    const config = JSON.parse(rule.config);
    return Array.isArray(config.tools) ? config.tools : [];
  } catch {
    return [];
  }
}

/**
 * Run a quality check prompt via the Anthropic SDK or CLI agent.
 * Agent-type rules get tool access (Read, Glob, Grep) so they can inspect actual files.
 *
 * @param {object} rule - The quality rule
 * @param {string} context - Conversation + git context
 * @param {object} [options] - Additional options
 * @param {string} [options.cwd] - Working directory for agent-type checks
 * Returns { result: 'pass'|'fail', details: string|null, analysis: string|null }
 */
async function runQualityCheck(rule, context, options = {}) {
  try {
    if (options.signal?.aborted) return null;

    const isAgent = rule.hook_type === 'agent';
    const tools = isAgent ? getAllowedTools(rule) : [];

    const agentInstructions = isAgent && tools.length > 0
      ? `\n\nYou have access to these tools: ${tools.join(', ')}. Use them to read and inspect the actual code files — do not rely solely on the conversation context. Check the real files to verify changes were made correctly.`
      : '';

    const { text: resolvedRulePrompt, unresolved } = await mergeFields.resolvePrompt(rule.prompt || '', {
      workingDirectory: options.cwd,
    });
    if (unresolved.length > 0) {
      console.warn(`[QualityRunner] Unresolved merge fields in rule ${rule.id}:`, unresolved.map(u => `${u.name} (${u.reason})`).join(', '));
    }

    const prompt = `${resolvedRulePrompt}${agentInstructions}

Context about what just happened:
${context}

IMPORTANT: After your evaluation, report the result by including one of these markers at the very end of your response:
QUALITY_RESULT:${rule.id}:${rule.severity}:PASS
or
QUALITY_RESULT:${rule.id}:${rule.severity}:FAIL:[brief reason]`;

    let fullText;

    const systemPrompt = 'You are a code quality reviewer. Be concise. Evaluate the code change and report PASS or FAIL with the exact QUALITY_RESULT marker format requested. Use the git state provided in the context to verify what actually happened — do not claim commits do not exist unless you have checked the git log. Focus your review on the actual code changes shown in the context.';

    if (rule.execution_mode === 'cli') {
      fullText = await cliRun(`${systemPrompt}\n\n${prompt}`, {
        allowedTools: tools.length > 0 ? tools : undefined,
        cwd: options.cwd || undefined,
        timeout: isAgent ? 180000 : 120000,
        signal: options.signal,
      }) || '';
    } else {
      fullText = await chatCompletion({
        model: MODEL_ROLES.quality,
        max_tokens: isAgent ? 1000 : 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
        signal: options.signal,
      }) || '';
    }

    const analysis = fullText.replace(/QUALITY_RESULT:\S+:\w+:(?:PASS|FAIL)(?::.*)?/g, '').trim();
    const match = fullText.match(/QUALITY_RESULT:(\S+):(\w+):(PASS|FAIL)(?::(.*))?/);
    if (match) {
      const [, , , result, details] = match;
      return { result: result.toLowerCase(), details: details || null, analysis };
    }
    return { result: 'pass', details: 'Quality check completed (no explicit marker)', analysis };
  } catch (e) {
    if (e.message === 'Aborted' || e.name === 'AbortError') return null;
    console.error(`[QualityRunner] Error running check ${rule.id}:`, e.message);
    return null;
  }
}

/**
 * Run spec-compliance check with the actual spec document content.
 * Uses a more thorough prompt that includes the spec text.
 * Returns { result: 'pass'|'fail', details: string|null, analysis: string|null }
 */
async function runSpecComplianceCheck(rule, specContent, specPath, conversationContext, options = {}) {
  try {
    if (options.signal?.aborted) return null;

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

    let fullText;

    const specSystemPrompt = 'You are a strict spec compliance reviewer. Be thorough — enumerate every requirement from the spec and check each one. Use the git state provided in the context to verify what was actually committed. Do not claim commits do not exist unless you have checked the git log. If you cannot confirm a requirement was implemented from the conversation context or git history, mark it incomplete.';

    if (rule.execution_mode === 'cli') {
      const tools = getAllowedTools(rule);
      fullText = await cliRun(`${specSystemPrompt}\n\n${prompt}`, {
        allowedTools: tools.length > 0 ? tools : undefined,
        cwd: options.cwd || undefined,
        signal: options.signal,
      }) || '';
    } else {
      fullText = await chatCompletion({
        model: MODEL_ROLES.quality,
        max_tokens: 1500,
        system: specSystemPrompt,
        messages: [{ role: 'user', content: prompt }],
        signal: options.signal,
      }) || '';
    }
    const analysis = fullText.replace(/QUALITY_RESULT:\S+:\w+:(?:PASS|FAIL)(?::.*)?/g, '').trim();
    const match = fullText.match(/QUALITY_RESULT:(\S+):(\w+):(PASS|FAIL)(?::(.*))?/);
    if (match) {
      const [, , , result, details] = match;
      return { result: result.toLowerCase(), details: details || null, analysis };
    }
    return { result: 'pass', details: 'Spec check completed (no explicit marker)', analysis };
  } catch (e) {
    if (e.message === 'Aborted' || e.name === 'AbortError') return null;
    console.error(`[QualityRunner] Error running spec compliance check:`, e.message);
    return null;
  }
}

/**
 * Broadcast that a quality check is starting (so UI can show a spinner).
 */
function broadcastRunning(sessionId, rule, broadcast, abortController) {
  const entry = {
    ruleId: rule.id,
    ruleName: rule.name,
    severity: rule.severity,
    trigger: rule.fires_on,
    timestamp: new Date().toISOString(),
    abortController: abortController || null
  };

  // Track in memory so clients can recover running state on reload
  if (!runningChecks.has(sessionId)) runningChecks.set(sessionId, new Map());
  runningChecks.get(sessionId).set(rule.id, entry);

  if (broadcast) {
    broadcast({ type: 'quality_running', sessionId, ...entry, abortController: undefined });
  }
}

/**
 * Save a quality result to DB and broadcast to session listeners.
 */
async function saveAndBroadcast(sessionId, rule, result, broadcast) {
  // Remove from running tracker — this check is done
  const sessionRunning = runningChecks.get(sessionId);
  if (sessionRunning) {
    sessionRunning.delete(rule.id);
    if (sessionRunning.size === 0) runningChecks.delete(sessionId);
  }

  await query(
    `INSERT INTO quality_results (session_id, rule_id, rule_name, result, severity, details, analysis, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [sessionId, rule.id, rule.name, result.result, rule.severity, result.details, result.analysis || null]
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

  // Match standard PostToolUse rules
  const postToolRules = rules.filter(r => {
    const triggers = r.fires_on.split(',').map(s => s.trim());
    return triggers.some(t => {
      const [event, matcher] = t.split(':');
      return event === 'PostToolUse' && toolMatchesMatcher(toolName, matcher);
    });
  });

  // Match PRCreated rules: fires when Bash runs "gh pr create" or "git push" (PR update)
  const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput || '');
  const isPRActivity = toolName === 'Bash' && (inputStr.includes('gh pr create') || inputStr.includes('git push'));
  const prCreatedRules = isPRActivity ? rules.filter(r => {
    const triggers = r.fires_on.split(',').map(s => s.trim());
    return triggers.includes('PRCreated');
  }) : [];

  const matchingRules = [...postToolRules, ...prCreatedRules];
  if (matchingRules.length === 0) return [];

  // Build context from tool use
  const context = `Tool used: ${toolName}\nInput: ${JSON.stringify(toolInput).slice(0, 1000)}`;

  // Run all matching rules in parallel, skipping any already running for this session
  let toolCwd = toolInput?.file_path ? path.dirname(toolInput.file_path) : undefined;

  // For Bash tools (e.g. git push, gh pr create), file_path is absent.
  // Fall back to the session's working directory from the database.
  if (!toolCwd) {
    const { rows: sessionRows } = await query(
      'SELECT working_directory FROM sessions WHERE id = $1',
      [sessionId]
    );
    toolCwd = sessionRows[0]?.working_directory || undefined;
  }

  const failuresToSend = [];

  await Promise.all(matchingRules.map(async (rule) => {
    if (rule.hook_type === 'command') return;

    // Skip if this rule is already running for this session (prevents duplicate triggers)
    const sessionRunning = runningChecks.get(sessionId);
    if (sessionRunning && sessionRunning.has(rule.id)) {
      console.log(`[QualityRunner] Rule "${rule.name}" already running for session ${sessionId.slice(0, 8)} — skipping duplicate`);
      return;
    }

    const abortController = new AbortController();
    broadcastRunning(sessionId, rule, broadcast, abortController);

    const result = await runQualityCheck(rule, context, { cwd: toolCwd, signal: abortController.signal });
    if (result) {
      await saveAndBroadcast(sessionId, rule, result, broadcast);

      // Collect failures for rules with send_fail_to_agent enabled
      if (result.result === 'fail' && rule.send_fail_to_agent) {
        console.log(`[QualityRunner] Rule "${rule.name}" failed with send_fail_to_agent (onToolUse) — will message agent`);
        failuresToSend.push({
          ruleId: rule.id,
          ruleName: rule.name,
          analysis: result.analysis,
          details: result.details,
        });
      }
    } else {
      // Error case — clean up running tracker so it doesn't stick forever
      const sr = runningChecks.get(sessionId);
      if (sr) {
        sr.delete(rule.id);
        if (sr.size === 0) runningChecks.delete(sessionId);
      }
    }
  }));

  return failuresToSend;
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

  if (stopRules.length === 0) {
    if (broadcast) {
      broadcast({ type: 'quality_checks_done', sessionId, count: 0, timestamp: new Date().toISOString() });
    }
    return [];
  }

  // Get session working directory and has_spec flag
  const { rows: sessionRows } = await query(
    'SELECT working_directory, has_spec FROM sessions WHERE id = $1',
    [sessionId]
  );
  const cwd = sessionRows[0]?.working_directory || null;
  const hasSpecFlag = !!sessionRows[0]?.has_spec;

  // Check for spec file on disk, then fall back to message attachments
  let spec = findSpecFile(cwd);
  if (!spec.found) {
    spec = await findSpecFromAttachments(sessionId);
  }

  // Gather git context (recent commits, diff) so reviewers can verify actual changes
  const gitContext = await getGitContext(cwd);

  // Get recent session messages for context
  const { rows: messages } = await query(
    'SELECT role, content FROM messages WHERE session_id = $1 ORDER BY timestamp DESC LIMIT 20',
    [sessionId]
  );
  const context = messages.reverse()
    .map(m => `${m.role}: ${m.content?.slice(0, 1000) || ''}`)
    .join('\n\n') + gitContext;

  // Run all stop rules in parallel, collecting failures for agent feedback
  const failuresToSend = [];

  await Promise.all(stopRules.map(async (rule) => {
    if (rule.hook_type === 'command') return;

    // If rule requires a spec document to run, skip it when no spec is found AND no spec was attached to this session
    if (rule.send_fail_requires_spec && !spec.found && !hasSpecFlag) {
      console.log(`[QualityRunner] Rule "${rule.name}" requires spec document but none found — skipping`);
      return;
    }

    const abortController = new AbortController();
    broadcastRunning(sessionId, rule, broadcast, abortController);

    let result;

    // For spec-compliance with a real spec file, use the enhanced check
    if (rule.id === 'spec-compliance' && spec.found) {
      console.log(`[QualityRunner] Spec file found at ${spec.path} — running enforcement-mode check`);
      result = await runSpecComplianceCheck(rule, spec.content, spec.path, context, { cwd, signal: abortController.signal });
    } else {
      result = await runQualityCheck(rule, context, { cwd, signal: abortController.signal });
    }

    if (!result) {
      // Error case — clean up running tracker
      const sr = runningChecks.get(sessionId);
      if (sr) {
        sr.delete(rule.id);
        if (sr.size === 0) runningChecks.delete(sessionId);
      }
      return;
    }

    await saveAndBroadcast(sessionId, rule, result, broadcast);

    // Collect failures for rules with send_fail_to_agent enabled
    if (result.result === 'fail' && rule.send_fail_to_agent) {
      // If requires_spec is set, only send when a spec file is present or was attached to this session
      if (rule.send_fail_requires_spec && !spec.found && !hasSpecFlag) {
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
  }));

  if (broadcast) {
    broadcast({ type: 'quality_checks_done', sessionId, timestamp: new Date().toISOString() });
  }

  return failuresToSend;
}

/**
 * Get currently-running quality checks for a session.
 * Returns an array of { ruleId, ruleName, severity, trigger, timestamp }.
 */
function getRunningChecks(sessionId) {
  const sessionRunning = runningChecks.get(sessionId);
  if (!sessionRunning) return [];
  return Array.from(sessionRunning.values()).map(({ abortController, ...rest }) => rest);
}

/**
 * Cancel a running quality check for a session.
 * Returns true if the check was found and cancelled, false otherwise.
 */
function cancelCheck(sessionId, ruleId, broadcast) {
  const sessionRunning = runningChecks.get(sessionId);
  if (!sessionRunning) return false;

  const entry = sessionRunning.get(ruleId);
  if (!entry || !entry.abortController) return false;

  // Abort the subprocess/API call
  entry.abortController.abort();

  // Clean up running tracker
  sessionRunning.delete(ruleId);
  if (sessionRunning.size === 0) runningChecks.delete(sessionId);

  // Broadcast cancelled result to UI
  if (broadcast) {
    broadcast({
      type: 'quality_result',
      sessionId,
      ruleId,
      ruleName: entry.ruleName,
      result: 'cancelled',
      severity: entry.severity,
      details: null,
      analysis: null,
      trigger: entry.trigger,
      timestamp: new Date().toISOString()
    });
  }

  console.log(`[QualityRunner] Cancelled check "${ruleId}" for session ${sessionId.slice(0, 8)}`);
  return true;
}

module.exports = { onToolUse, onSessionStop, invalidateRulesCache, getRunningChecks, cancelCheck, runQualityCheck, runSpecComplianceCheck, broadcastRunning, saveAndBroadcast, findSpecFile, findSpecFromAttachments, getGitContext };
