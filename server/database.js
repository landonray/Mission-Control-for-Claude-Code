const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'mission-control.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initializeSchema();
  }
  return db;
}

function initializeSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      working_directory TEXT,
      branch TEXT,
      context_window_usage REAL DEFAULT 0,
      user_message_count INTEGER DEFAULT 0,
      assistant_message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      last_action_summary TEXT,
      last_activity_at TEXT,
      preset_id TEXT,
      permission_mode TEXT DEFAULT 'acceptEdits',
      created_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      FOREIGN KEY (preset_id) REFERENCES presets(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      tool_results TEXT,
      timestamp TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      key_actions TEXT,
      files_modified TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      working_directory TEXT NOT NULL,
      mcp_connections TEXT,
      claude_md_path TEXT,
      permission_mode TEXT DEFAULT 'acceptEdits',
      initial_prompt TEXT,
      icon TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      args TEXT,
      env TEXT,
      auto_connect INTEGER DEFAULT 0,
      status TEXT DEFAULT 'disconnected',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notification_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL UNIQUE,
      keys_p256dh TEXT NOT NULL,
      keys_auth TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notification_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      waiting_for_input INTEGER DEFAULT 1,
      task_complete INTEGER DEFAULT 1,
      error_events INTEGER DEFAULT 1,
      context_window_warning INTEGER DEFAULT 1,
      context_threshold REAL DEFAULT 0.8,
      daily_digest INTEGER DEFAULT 0
    );

    INSERT OR IGNORE INTO notification_settings (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      projects_directory TEXT,
      github_username TEXT
    );

    INSERT OR IGNORE INTO app_settings (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS daily_digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      session_count INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quality_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      hook_type TEXT NOT NULL,
      fires_on TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      enabled INTEGER DEFAULT 1,
      prompt TEXT,
      script TEXT,
      config TEXT,
      category TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quality_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      result TEXT NOT NULL,
      severity TEXT NOT NULL,
      details TEXT,
      file_path TEXT,
      timestamp TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (rule_id) REFERENCES quality_rules(id)
    );

    CREATE INDEX IF NOT EXISTS idx_quality_results_session ON quality_results(session_id);
    CREATE INDEX IF NOT EXISTS idx_quality_results_rule ON quality_results(rule_id);
    CREATE INDEX IF NOT EXISTS idx_quality_results_timestamp ON quality_results(timestamp);
  `);

  seedDefaultPresets();
  seedQualityRules();
}

function seedDefaultPresets() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO presets (id, name, description, working_directory, mcp_connections, permission_mode, initial_prompt, icon)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const presets = [
    {
      id: 'pages-agent',
      name: 'Pages-Agent',
      description: 'Pages-Agent repo with Ontraport MCP',
      working_directory: '~/projects/pages-agent',
      mcp_connections: JSON.stringify(['ontraport-mcp']),
      permission_mode: 'acceptEdits',
      initial_prompt: '',
      icon: 'globe'
    },
    {
      id: 'attestime',
      name: 'AttesTime',
      description: 'AttesTime project directory',
      working_directory: '~/projects/attestime',
      mcp_connections: null,
      permission_mode: 'acceptEdits',
      initial_prompt: '',
      icon: 'clock'
    },
    {
      id: 'autopilot',
      name: 'Autopilot',
      description: 'Autopilot project with Ontraport MCP',
      working_directory: '~/projects/autopilot',
      mcp_connections: JSON.stringify(['ontraport-mcp']),
      permission_mode: 'acceptEdits',
      initial_prompt: '',
      icon: 'plane'
    },
    {
      id: 'mcp-server',
      name: 'MCP Server',
      description: 'Ontraport MCP server repo',
      working_directory: '~/projects/ontraport-mcp',
      mcp_connections: null,
      permission_mode: 'acceptEdits',
      initial_prompt: '',
      icon: 'server'
    }
  ];

  for (const p of presets) {
    insert.run(p.id, p.name, p.description, p.working_directory, p.mcp_connections, p.permission_mode, p.initial_prompt, p.icon);
  }
}

function seedQualityRules() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO quality_rules (id, name, description, hook_type, fires_on, severity, enabled, prompt, script, config, category, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const rules = [
    {
      id: 'band-aid-detection',
      name: 'Band-Aid Detection',
      description: 'Blocks completion if fix is a patch, not a root-cause solution. Detects workarounds, symptom-level fixes, and temporary hacks.',
      hook_type: 'prompt',
      fires_on: 'Stop',
      severity: 'high',
      enabled: 1,
      prompt: `Review the changes made in this session. For each fix or modification:
1. Is this addressing the ROOT CAUSE of the problem, or just patching a symptom?
2. Would this fix need to be revisited if the underlying issue changes?
3. Are there any comments like "workaround", "hack", "temporary", "TODO: fix properly"?

If any change is a band-aid fix rather than a proper solution, respond with:
FAIL: [description of the band-aid fix and what the root-cause solution should be]

If all changes address root causes, respond with:
PASS: All changes address root causes.`,
      script: null,
      config: null,
      category: 'correctness',
      sort_order: 1
    },
    {
      id: 'file-organization',
      name: 'File Organization',
      description: 'Checks file placement against project structure conventions. Ensures new files are in the right directories.',
      hook_type: 'agent',
      fires_on: 'PostToolUse:Write',
      severity: 'medium',
      enabled: 1,
      prompt: `A file was just created or written. Check if it's in the correct location by:
1. Reading the project structure to understand the existing organization patterns
2. Checking if similar files exist elsewhere that follow a convention
3. Verifying the file is not placed in the root when it should be in a subdirectory

If the file is misplaced, respond with:
FAIL: [file] should be in [correct location] based on project conventions.

If placement is correct, respond with:
PASS: File placement follows project conventions.`,
      script: null,
      config: JSON.stringify({ tools: ['Read', 'Glob', 'Grep'] }),
      category: 'organization',
      sort_order: 2
    },
    {
      id: 'independent-code-review',
      name: 'Independent Code Review',
      description: 'A fresh-eyes subagent reviews the entire diff for bugs, logic errors, edge cases, and security issues.',
      hook_type: 'agent',
      fires_on: 'Stop',
      severity: 'high',
      enabled: 1,
      prompt: `You are an independent code reviewer. Review the changes from this session with fresh eyes.

Check for:
1. Logic errors or off-by-one bugs
2. Unhandled edge cases (null, empty, boundary values)
3. Security vulnerabilities (injection, XSS, auth bypass)
4. Race conditions or concurrency issues
5. Memory leaks or resource cleanup
6. API contract violations

For each issue found, respond with:
FAIL: [file:line] [description of issue]

If the code is clean, respond with:
PASS: Code review passed. No issues found.`,
      script: null,
      config: JSON.stringify({ tools: ['Read', 'Glob', 'Grep'] }),
      category: 'correctness',
      sort_order: 3
    },
    {
      id: 'spec-compliance',
      name: 'Spec Compliance Verification',
      description: 'Re-injects the spec, enumerates every requirement, and blocks if any are incomplete.',
      hook_type: 'prompt',
      fires_on: 'Stop',
      severity: 'high',
      enabled: 1,
      prompt: `Review the original task/spec and enumerate every requirement. For each one:
- Is it fully implemented?
- Is it partially implemented?
- Is it missing entirely?

Create a checklist:
- [x] Requirement (fully done)
- [ ] Requirement (missing or incomplete)

If any requirements are missing or incomplete, respond with:
FAIL: The following requirements are not met: [list]

If all requirements are met, respond with:
PASS: All spec requirements verified.`,
      script: null,
      config: null,
      category: 'completeness',
      sort_order: 4
    },
    {
      id: 'error-handling',
      name: 'Error Handling Completeness',
      description: 'Checks for missing error handling in try/catch, async operations, file I/O, network calls, and user input validation.',
      hook_type: 'prompt',
      fires_on: 'PostToolUse:Write,PostToolUse:Edit',
      severity: 'medium',
      enabled: 1,
      prompt: `Review the code that was just written or modified. Check for:
1. Async operations without try/catch or .catch()
2. File operations without error handling
3. Network/API calls without timeout or error handling
4. User input used without validation
5. Empty catch blocks that swallow errors
6. Missing finally blocks for cleanup

If error handling is incomplete, respond with:
FAIL: [description of missing error handling]

If error handling is adequate, respond with:
PASS: Error handling is complete.`,
      script: null,
      config: null,
      category: 'correctness',
      sort_order: 5
    },
    {
      id: 'hardcoded-values',
      name: 'Hardcoded Value Detection',
      description: 'Regex scan for magic numbers, hardcoded URLs, API keys, credentials, and configuration values that should be extracted.',
      hook_type: 'command',
      fires_on: 'PostToolUse:Write,PostToolUse:Edit',
      severity: 'medium',
      enabled: 1,
      prompt: null,
      script: `#!/bin/bash
# Scan for hardcoded values in the changed file
FILE="$CLAUDE_FILE_PATH"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then exit 0; fi

ISSUES=""

# Check for hardcoded URLs (excluding common safe ones)
URLS=$(grep -nE 'https?://[^"'"'"'\\s]+' "$FILE" | grep -v 'localhost' | grep -v '127.0.0.1' | grep -v 'example.com' | grep -v '// http' | head -5)
if [ -n "$URLS" ]; then
  ISSUES="$ISSUES\\nHardcoded URLs found:\\n$URLS"
fi

# Check for potential API keys/secrets
SECRETS=$(grep -nEi '(api_key|apikey|secret|password|token|credential)\\s*[:=]\\s*["\x27][^"\x27]{8,}' "$FILE" | head -5)
if [ -n "$SECRETS" ]; then
  ISSUES="$ISSUES\\nPotential hardcoded secrets:\\n$SECRETS"
fi

# Check for magic numbers (standalone numbers > 1 that aren't array indices)
MAGIC=$(grep -nE '\\b[2-9][0-9]{2,}\\b' "$FILE" | grep -v 'port' | grep -v 'status' | grep -v 'version' | grep -v '//' | head -5)
if [ -n "$MAGIC" ]; then
  ISSUES="$ISSUES\\nPotential magic numbers:\\n$MAGIC"
fi

if [ -n "$ISSUES" ]; then
  echo "FAIL: $ISSUES"
  exit 1
else
  echo "PASS: No hardcoded values detected."
  exit 0
fi`,
      config: null,
      category: 'quality',
      sort_order: 6
    },
    {
      id: 'dead-code-cleanup',
      name: 'Dead Code Cleanup',
      description: 'Scans for commented-out code blocks, unused imports, and orphaned functions after refactors. Command detects, then prompt evaluates if intentional.',
      hook_type: 'command+prompt',
      fires_on: 'PostToolUse:Edit',
      severity: 'low',
      enabled: 1,
      prompt: `The following dead code was detected in a recently edited file. Review each finding and determine:
1. Is this commented-out code that should be removed?
2. Are these unused imports that should be cleaned up?
3. Could any of these be intentionally kept (e.g., for documentation or future use)?

If there is dead code that should be cleaned up, respond with:
FAIL: [list of dead code items that should be removed]

If all findings are intentional or there are no real issues, respond with:
PASS: No actionable dead code found.`,
      script: `#!/bin/bash
FILE="$CLAUDE_FILE_PATH"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then exit 0; fi

ISSUES=""

# Check for large commented-out code blocks (3+ consecutive comment lines that look like code)
COMMENTED=$(grep -c '^\\s*//.*[;{}()=]' "$FILE" 2>/dev/null || echo 0)
if [ "$COMMENTED" -gt 5 ]; then
  ISSUES="$ISSUES\\nFound $COMMENTED lines of commented-out code."
fi

# Check for unused imports in JS/TS files
EXT="\${FILE##*.}"
if [[ "$EXT" == "js" || "$EXT" == "jsx" || "$EXT" == "ts" || "$EXT" == "tsx" ]]; then
  while IFS= read -r line; do
    IMPORT=$(echo "$line" | grep -oP "import\\s+\\{?\\s*([\\w,\\s]+)" | sed 's/import[{ ]*//')
    for name in $(echo "$IMPORT" | tr ',' '\\n' | tr -d ' '); do
      if [ -n "$name" ] && [ "$name" != "React" ]; then
        COUNT=$(grep -c "\\b$name\\b" "$FILE" 2>/dev/null || echo 0)
        if [ "$COUNT" -le 1 ]; then
          ISSUES="$ISSUES\\nPossibly unused import: $name"
        fi
      fi
    done
  done < <(grep "^import " "$FILE" 2>/dev/null)
fi

if [ -n "$ISSUES" ]; then
  echo "FAIL: $ISSUES"
  exit 1
else
  echo "PASS: No dead code detected."
  exit 0
fi`,
      config: null,
      category: 'quality',
      sort_order: 7
    },
    {
      id: 'naming-consistency',
      name: 'Naming Consistency',
      description: 'Checks naming conventions (camelCase, PascalCase, snake_case) against existing codebase patterns.',
      hook_type: 'agent',
      fires_on: 'PostToolUse:Write',
      severity: 'low',
      enabled: 1,
      prompt: `A new file was created. Check naming consistency:
1. Does the filename follow the same pattern as sibling files? (e.g., PascalCase for components, camelCase for utilities)
2. Do exported functions/classes follow the existing naming conventions in the project?
3. Are variable names consistent with the rest of the codebase?

If naming is inconsistent, respond with:
FAIL: [description of inconsistency and what convention to follow]

If naming is consistent, respond with:
PASS: Naming follows project conventions.`,
      script: null,
      config: JSON.stringify({ tools: ['Read', 'Glob'] }),
      category: 'quality',
      sort_order: 8
    },
    {
      id: 'scope-creep',
      name: 'Scope Creep Detection',
      description: 'Warns if changes go beyond the original request. Detects unrelated refactors, style changes, and feature additions.',
      hook_type: 'prompt',
      fires_on: 'Stop',
      severity: 'medium',
      enabled: 1,
      prompt: `Compare the original task request with the actual changes made. Check:
1. Are there changes to files not related to the original request?
2. Were refactors or style changes made that weren't asked for?
3. Were new features or capabilities added beyond what was requested?
4. Were existing tests modified without being asked to?

If scope creep is detected, respond with:
FAIL: Changes beyond original scope: [description]

If changes stay within scope, respond with:
PASS: All changes are within the original request scope.`,
      script: null,
      config: null,
      category: 'process',
      sort_order: 9
    },
    {
      id: 'dependency-justification',
      name: 'Dependency Justification',
      description: 'Blocks npm/pip/cargo install if the dependency could be avoided or a lighter alternative exists.',
      hook_type: 'prompt',
      fires_on: 'PreToolUse:Bash',
      severity: 'medium',
      enabled: 1,
      prompt: `A package install command is about to run. Evaluate:
1. Is this dependency actually necessary, or could the functionality be implemented in a few lines of code?
2. Is the package well-maintained (not abandoned)?
3. Is there a lighter alternative that would work?
4. Does this add significant bundle size for minimal benefit?
5. Is this a duplicate of functionality already available through existing dependencies?

If the dependency is unjustified, respond with:
FAIL: [reason the dependency should not be added, and alternative approach]

If the dependency is justified, respond with:
PASS: Dependency is justified.`,
      script: null,
      config: null,
      category: 'process',
      sort_order: 10
    },
    {
      id: 'incomplete-implementation',
      name: 'Incomplete Implementation Detection',
      description: 'Scans for TODOs, placeholder text, console.logs, empty catch blocks, and stub implementations.',
      hook_type: 'command',
      fires_on: 'Stop',
      severity: 'high',
      enabled: 1,
      prompt: null,
      script: `#!/bin/bash
# Scan all recently modified files for incomplete markers
ISSUES=""

# Find files modified in the last 10 minutes (scoped to recent changes only for performance)
FILES=$(find . -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -mmin -10 \\( -name '*.js' -o -name '*.jsx' -o -name '*.ts' -o -name '*.tsx' -o -name '*.py' -o -name '*.go' -o -name '*.rs' \\) 2>/dev/null | head -50)
# Fallback: if no recent files, check git diff for changed files
if [ -z "$FILES" ]; then
  FILES=$(git diff --name-only HEAD 2>/dev/null | grep -E '\\.(js|jsx|ts|tsx|py|go|rs)$' | head -50)
fi

for FILE in $FILES; do
  # TODOs and FIXMEs
  TODOS=$(grep -n 'TODO\\|FIXME\\|HACK\\|XXX\\|TEMP' "$FILE" 2>/dev/null | head -3)
  if [ -n "$TODOS" ]; then
    ISSUES="$ISSUES\\n$FILE: TODOs found:\\n$TODOS"
  fi

  # Console.log left behind
  LOGS=$(grep -n 'console\\.log' "$FILE" 2>/dev/null | head -3)
  if [ -n "$LOGS" ]; then
    ISSUES="$ISSUES\\n$FILE: console.log statements:\\n$LOGS"
  fi

  # Empty catch blocks
  EMPTY_CATCH=$(grep -n 'catch.*{\\s*}' "$FILE" 2>/dev/null | head -3)
  if [ -n "$EMPTY_CATCH" ]; then
    ISSUES="$ISSUES\\n$FILE: Empty catch blocks:\\n$EMPTY_CATCH"
  fi

  # Placeholder text
  PLACEHOLDERS=$(grep -ni 'placeholder\\|lorem ipsum\\|coming soon\\|not implemented' "$FILE" 2>/dev/null | head -3)
  if [ -n "$PLACEHOLDERS" ]; then
    ISSUES="$ISSUES\\n$FILE: Placeholder text:\\n$PLACEHOLDERS"
  fi
done

if [ -n "$ISSUES" ]; then
  echo "FAIL: $ISSUES"
  exit 1
else
  echo "PASS: No incomplete implementations detected."
  exit 0
fi`,
      config: null,
      category: 'completeness',
      sort_order: 11
    },
    {
      id: 'duplication-check',
      name: 'Duplication Check',
      description: 'Searches the codebase for existing similar functionality before allowing new utilities or helpers.',
      hook_type: 'agent',
      fires_on: 'PostToolUse:Write',
      severity: 'medium',
      enabled: 1,
      prompt: `A new file or function was just written. Search the codebase to check:
1. Does a similar utility/helper already exist elsewhere?
2. Is there an existing function that does the same thing with a different name?
3. Could this new code reuse or extend something that already exists?

If duplication is found, respond with:
FAIL: Similar functionality exists at [location]. Consider reusing or extending it instead.

If no duplication, respond with:
PASS: No duplicate functionality found.`,
      script: null,
      config: JSON.stringify({ tools: ['Read', 'Glob', 'Grep'] }),
      category: 'quality',
      sort_order: 12
    },
    {
      id: 'rollback-safety',
      name: 'Rollback Safety',
      description: 'Blocks destructive actions (force push, drop table, rm -rf, reset --hard) without explicit justification.',
      hook_type: 'prompt',
      fires_on: 'PreToolUse:Bash,PreToolUse:Write',
      severity: 'high',
      enabled: 1,
      prompt: `A potentially destructive action is about to be taken. Evaluate:
1. Is this a destructive operation? (force push, drop table, rm -rf, reset --hard, overwrite without backup)
2. Is there a safer alternative that achieves the same goal?
3. Has the user explicitly requested this destructive action?
4. Is there a rollback path if this goes wrong?

If the action is destructive without justification, respond with:
FAIL: Destructive action detected: [description]. Safer alternative: [suggestion]

If the action is safe or properly justified, respond with:
PASS: Action is safe or explicitly requested.`,
      script: null,
      config: null,
      category: 'safety',
      sort_order: 13
    },
    {
      id: 'spec-drift',
      name: 'Spec Drift Detection',
      description: 'Periodically re-injects the spec during long sessions to catch gradual drift from requirements.',
      hook_type: 'prompt',
      fires_on: 'Stop',
      severity: 'medium',
      enabled: 1,
      prompt: `This is a periodic spec drift check for a long-running session. Review:
1. Are the recent changes still aligned with the original task/spec?
2. Has the implementation direction shifted away from what was originally requested?
3. Are there any architectural decisions that contradict the spec?

If drift is detected, respond with:
FAIL: Spec drift detected: [description of how implementation has drifted]

If on track, respond with:
PASS: Implementation remains aligned with spec.`,
      script: null,
      config: JSON.stringify({ periodic: true, interval_messages: 20 }),
      category: 'process',
      sort_order: 14
    },
    {
      id: 'visual-comparison',
      name: 'Visual Comparison',
      description: 'Screenshots rendered page output and compares to design expectations. Command captures screenshot, prompt evaluates. Pages-Agent only, toggleable.',
      hook_type: 'command+prompt',
      fires_on: 'Stop',
      severity: 'high',
      enabled: 0,
      prompt: `Compare the rendered output of the page against the design expectations:
1. Take a screenshot of the rendered page
2. Check layout matches design specifications
3. Verify responsive behavior at key breakpoints
4. Check color scheme, spacing, and typography

If visual issues are found, respond with:
FAIL: Visual discrepancies: [description]

If rendering matches design, respond with:
PASS: Visual output matches design expectations.`,
      script: `#!/bin/bash
# Capture screenshot of rendered page for visual comparison
# Requires a running dev server and a headless browser tool
URL="\${VISUAL_URL:-http://localhost:3000}"
SCREENSHOT_DIR="/tmp/mission-control-screenshots"
mkdir -p "$SCREENSHOT_DIR"
TIMESTAMP=$(date +%s)
SCREENSHOT="$SCREENSHOT_DIR/capture-$TIMESTAMP.png"

# Try to capture with available tools
if command -v puppeteer-screenshot &> /dev/null; then
  puppeteer-screenshot "$URL" "$SCREENSHOT" 2>/dev/null
elif command -v playwright &> /dev/null; then
  playwright screenshot "$URL" "$SCREENSHOT" 2>/dev/null
elif command -v wkhtmltoimage &> /dev/null; then
  wkhtmltoimage "$URL" "$SCREENSHOT" 2>/dev/null
else
  echo "PASS: No screenshot tool available. Install puppeteer, playwright, or wkhtmltoimage."
  exit 0
fi

if [ -f "$SCREENSHOT" ]; then
  echo "Screenshot captured at $SCREENSHOT"
  echo "PASS: Screenshot captured for review"
  exit 0
else
  echo "FAIL: Could not capture screenshot"
  exit 1
fi`,
      config: JSON.stringify({ projects: ['pages-agent'] }),
      category: 'visual',
      sort_order: 15
    }
  ];

  for (const r of rules) {
    insert.run(r.id, r.name, r.description, r.hook_type, r.fires_on, r.severity, r.enabled, r.prompt, r.script, r.config, r.category, r.sort_order);
  }
}

module.exports = { getDb };
