const fs = require('fs');
const path = require('path');
const os = require('os');
const { getDb } = require('../database');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const SCRIPTS_DIR = path.join(os.homedir(), '.claude', 'mission-control-hooks');
const CALLBACK_URL = 'http://localhost:3000/api/quality/results';

/**
 * Generates Claude Code hooks configuration from active quality rules
 * and writes it to ~/.claude/settings.json (merging with existing config).
 */
function generateHooksConfig() {
  const db = getDb();
  const rules = db.prepare('SELECT * FROM quality_rules WHERE enabled = 1 ORDER BY sort_order').all();

  // All 21 Claude Code lifecycle events
  const ALL_EVENTS = [
    'SessionStart', 'SessionEnd', 'UserPromptSubmit',
    'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
    'Stop', 'SubagentStop', 'SubagentStart',
    'Notification', 'PreCompact', 'PostCompact',
    'WorktreeCreate', 'WorktreeRemove', 'CwdChanged',
    'Setup', 'InstructionsLoaded', 'ConfigChange',
    'TaskCreated', 'TaskCompleted', 'TeammateIdle'
  ];

  // Build hooks arrays by lifecycle event
  const hooks = {};
  for (const event of ALL_EVENTS) {
    hooks[event] = [];
  }

  // Ensure scripts directory exists
  if (!fs.existsSync(SCRIPTS_DIR)) {
    fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  }

  for (const rule of rules) {
    const hookEntries = buildHookEntries(rule);
    for (const entry of hookEntries) {
      if (hooks[entry.event]) {
        // For PostToolUse command hooks, wrap with debounce to batch burst edits
        if (entry.event === 'PostToolUse' && entry.hook.type === 'command') {
          entry.hook.command = buildDebouncedCommand(rule.id, entry.hook.command);
        }
        hooks[entry.event].push(entry.hook);
      }
    }
  }

  // Read existing settings
  let settings = {};
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
      settings = JSON.parse(content);
    }
  } catch (e) {
    settings = {};
  }

  // Merge hooks - preserve non-mission-control hooks
  if (!settings.hooks) settings.hooks = {};

  for (const event of ALL_EVENTS) {
    const existing = settings.hooks[event] || [];
    // Remove old mission-control hooks (identified by tag)
    const preserved = existing.filter(h => !h._missionControl);
    // Add new mission-control hooks (only add event key if there are hooks)
    const combined = [...preserved, ...hooks[event]];
    if (combined.length > 0) {
      settings.hooks[event] = combined;
    } else if (existing.length > 0 && hooks[event].length === 0) {
      // Preserve existing non-MC hooks, remove empty arrays
      settings.hooks[event] = preserved.length > 0 ? preserved : undefined;
      if (!settings.hooks[event]) delete settings.hooks[event];
    }
  }

  // Ensure directory exists
  const settingsDir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  // Write settings
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');

  return { success: true, ruleCount: rules.length, hooks: settings.hooks };
}

/**
 * Build hook entries for a single rule
 */
function buildHookEntries(rule) {
  const entries = [];
  const firesOn = rule.fires_on.split(',').map(s => s.trim());

  const config = rule.config ? JSON.parse(rule.config) : {};

  for (const trigger of firesOn) {
    const [event, toolFilter] = trigger.split(':');
    // All 21 lifecycle events are supported

    const hook = {
      _missionControl: true,
      _ruleId: rule.id,
      _ruleName: rule.name
    };

    // Add tool matcher for Pre/PostToolUse
    if (toolFilter && event !== 'Stop') {
      hook.matcher = toolFilter;
    }

    switch (rule.hook_type) {
      case 'command': {
        const { commandHook } = buildCommandHook(rule);
        Object.assign(hook, commandHook);
        break;
      }

      case 'prompt': {
        hook.type = 'prompt';
        hook.prompt = buildPromptWithCallback(rule);
        break;
      }

      case 'agent': {
        hook.type = 'prompt';
        hook.prompt = buildAgentPromptWithCallback(rule);
        if (config.tools) {
          hook.allowedTools = config.tools;
        }
        break;
      }

      case 'command+prompt': {
        // Two-phase: command detects, then prompt evaluates
        // Phase 1: Command hook
        const { commandHook } = buildCommandHook(rule);
        const commandEntry = {
          ...hook,
          ...commandHook,
          _phase: 'detect'
        };
        entries.push({ event, hook: commandEntry });

        // Phase 2: Prompt hook (evaluates command findings)
        const promptHook = {
          ...hook,
          _phase: 'evaluate',
          type: 'prompt',
          prompt: buildPromptWithCallback(rule)
        };
        entries.push({ event, hook: promptHook });
        continue; // Skip the push below since we already added both
      }
    }

    entries.push({ event, hook });
  }

  return entries;
}

/**
 * Build a command hook with wrapper for result reporting
 */
function buildCommandHook(rule) {
  const scriptPath = path.join(SCRIPTS_DIR, `${rule.id}.sh`);
  if (rule.script) {
    fs.writeFileSync(scriptPath, rule.script, { mode: 0o755 });
  }
  const wrapperPath = path.join(SCRIPTS_DIR, `${rule.id}-wrapper.sh`);
  // SESSION_ID is set by Claude Code hooks as an environment variable.
  // If not available, we try CLAUDE_SESSION_ID which is another common env var.
  const wrapperScript = `#!/bin/bash
OUTPUT=$(bash "${scriptPath}" 2>&1)
EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
  RESULT="pass"
else
  RESULT="fail"
fi
SID="\${SESSION_ID:-\${CLAUDE_SESSION_ID:-unknown}}"
DETAILS=$(echo "$OUTPUT" | head -c 500 | sed 's/"/\\\\"/g' | tr '\\n' ' ')
curl -s -X POST ${CALLBACK_URL} \\
  -H "Content-Type: application/json" \\
  -d "{\\"session_id\\":\\"$SID\\",\\"rule_id\\":\\"${rule.id}\\",\\"rule_name\\":\\"${rule.name}\\",\\"result\\":\\"$RESULT\\",\\"severity\\":\\"${rule.severity}\\",\\"details\\":\\"$DETAILS\\"}" > /dev/null 2>&1
exit $EXIT_CODE
`;
  fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });
  return {
    commandHook: {
      type: 'command',
      command: `bash "${wrapperPath}"`
    }
  };
}

/**
 * Build a prompt that includes callback instructions
 */
function buildPromptWithCallback(rule) {
  return `${rule.prompt}

IMPORTANT: After your evaluation, report the result by including one of these markers at the very end of your response:
QUALITY_RESULT:${rule.id}:${rule.severity}:PASS
or
QUALITY_RESULT:${rule.id}:${rule.severity}:FAIL:[brief reason]`;
}

/**
 * Build an agent prompt with tool access and callback
 */
function buildAgentPromptWithCallback(rule) {
  return `${rule.prompt}

You have access to Read, Glob, and Grep tools to inspect the codebase.

IMPORTANT: After your evaluation, report the result by including one of these markers at the very end of your response:
QUALITY_RESULT:${rule.id}:${rule.severity}:PASS
or
QUALITY_RESULT:${rule.id}:${rule.severity}:FAIL:[brief reason]`;
}

/**
 * Build a debounced command wrapper for PostToolUse batching.
 * Uses a lockfile with timestamp to skip checks if one ran recently (within 5 seconds).
 * This prevents running the same check on every individual file edit in a burst.
 */
function buildDebouncedCommand(ruleId, originalCommand) {
  const lockFile = path.join(SCRIPTS_DIR, `.${ruleId}.lastrun`);
  return `bash -c 'LOCK="${lockFile}"; NOW=$(date +%s); if [ -f "$LOCK" ]; then LAST=$(cat "$LOCK"); DIFF=$((NOW - LAST)); if [ $DIFF -lt 5 ]; then exit 0; fi; fi; echo $NOW > "$LOCK"; ${originalCommand.replace(/'/g, "'\\''")}'`;
}

/**
 * Remove all mission-control hooks from settings
 */
function removeHooksConfig() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return { success: true };

    const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(content);

    if (settings.hooks) {
      for (const event of Object.keys(settings.hooks)) {
        if (Array.isArray(settings.hooks[event])) {
          settings.hooks[event] = settings.hooks[event].filter(h => !h._missionControl);
          // Clean up empty arrays
          if (settings.hooks[event].length === 0) {
            delete settings.hooks[event];
          }
        }
      }
    }

    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Get current hooks status
 */
function getHooksStatus() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) {
      return { installed: false, ruleCount: 0 };
    }

    const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(content);
    let mcHookCount = 0;

    if (settings.hooks) {
      for (const event of Object.keys(settings.hooks)) {
        if (Array.isArray(settings.hooks[event])) {
          mcHookCount += settings.hooks[event].filter(h => h._missionControl).length;
        }
      }
    }

    return { installed: mcHookCount > 0, ruleCount: mcHookCount };
  } catch (e) {
    return { installed: false, ruleCount: 0, error: e.message };
  }
}

module.exports = {
  generateHooksConfig,
  removeHooksConfig,
  getHooksStatus,
  SCRIPTS_DIR,
  CALLBACK_URL
};
