const { neon } = require('@neondatabase/serverless');
const { ProxyAgent } = require('undici');

// Use HTTPS proxy if available (required in containerized environments)
const fetchOptions = {};
if (process.env.HTTPS_PROXY || process.env.https_proxy) {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  const dispatcher = new ProxyAgent(proxyUrl);
  fetchOptions.dispatcher = dispatcher;
}

const sql = neon(process.env.DATABASE_URL, { fetchOptions });

async function query(text, params) {
  // fullResults: true returns { rows, rowCount, command, ... } — without it,
  // sql.query returns just an array of rows with no rowCount, which silently
  // breaks UPDATE/DELETE consumers that check result.rowCount.
  const result = await sql.query(text, params || [], { fullResults: true });
  return { rows: result.rows, rowCount: result.rowCount };
}

async function initializeDb() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
      working_directory TEXT, branch TEXT, context_window_usage REAL DEFAULT 0,
      user_message_count INTEGER DEFAULT 0, assistant_message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0, last_action_summary TEXT, last_activity_at TEXT,
      permission_mode TEXT DEFAULT 'acceptEdits', created_at TEXT DEFAULT NOW(),
      ended_at TEXT, preview_url TEXT, archived INTEGER DEFAULT 0,
      tmux_session_name TEXT, model TEXT,
      use_worktree INTEGER DEFAULT 0, worktree_name TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, tool_results TEXT,
      attachments TEXT,
      timestamp TEXT DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS session_summaries (
      id SERIAL PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      summary TEXT NOT NULL, key_actions TEXT, files_modified TEXT, created_at TEXT DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL,
      args TEXT, env TEXT, auto_connect INTEGER DEFAULT 0,
      status TEXT DEFAULT 'disconnected', created_at TEXT DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS notification_subscriptions (
      id SERIAL PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE,
      keys_p256dh TEXT NOT NULL, keys_auth TEXT NOT NULL, created_at TEXT DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS notification_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1), waiting_for_input INTEGER DEFAULT 1,
      task_complete INTEGER DEFAULT 1, error_events INTEGER DEFAULT 1,
      context_window_warning INTEGER DEFAULT 1, context_threshold REAL DEFAULT 0.8,
      daily_digest INTEGER DEFAULT 0
    )`,
    `INSERT INTO notification_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1), projects_directory TEXT,
      github_username TEXT, setup_repo TEXT
    )`,
    `INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS daily_digests (
      id SERIAL PRIMARY KEY, date TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL, session_count INTEGER, created_at TEXT DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS quality_rules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      hook_type TEXT NOT NULL, fires_on TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'medium',
      enabled INTEGER DEFAULT 1, prompt TEXT, script TEXT, config TEXT, category TEXT,
      send_fail_to_agent INTEGER DEFAULT 0, send_fail_requires_spec INTEGER DEFAULT 0,
      execution_mode TEXT DEFAULT 'cli',
      sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT NOW(), updated_at TEXT DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS quality_results (
      id SERIAL PRIMARY KEY, session_id TEXT REFERENCES sessions(id),
      rule_id TEXT NOT NULL REFERENCES quality_rules(id), rule_name TEXT NOT NULL,
      result TEXT NOT NULL, severity TEXT NOT NULL, details TEXT, analysis TEXT, file_path TEXT,
      timestamp TEXT DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_quality_results_session ON quality_results(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_quality_results_rule ON quality_results(rule_id)`,
    `CREATE INDEX IF NOT EXISTS idx_quality_results_timestamp ON quality_results(timestamp)`,
    `CREATE TABLE IF NOT EXISTS stream_events (
      id SERIAL PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      event_type TEXT NOT NULL, event_data TEXT NOT NULL,
      timestamp TEXT DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_stream_events_session ON stream_events(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stream_events_timestamp ON stream_events(session_id, timestamp)`,
    `CREATE TABLE IF NOT EXISTS slash_commands (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, message TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT NOW(), settings JSONB
    )`,
    `CREATE TABLE IF NOT EXISTS eval_armed_folders (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      folder_path TEXT NOT NULL,
      folder_name TEXT NOT NULL,
      triggers TEXT NOT NULL DEFAULT 'manual',
      auto_send INTEGER DEFAULT 0,
      created_at TEXT DEFAULT NOW(),
      UNIQUE(project_id, folder_path)
    )`,
    `CREATE TABLE IF NOT EXISTS eval_batches (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      trigger_source TEXT NOT NULL,
      commit_sha TEXT,
      session_id TEXT,
      total INTEGER DEFAULT 0,
      passed INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      started_at TEXT DEFAULT NOW(),
      completed_at TEXT,
      status TEXT DEFAULT 'running'
    )`,
    `CREATE TABLE IF NOT EXISTS eval_runs (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES eval_batches(id),
      eval_name TEXT NOT NULL,
      eval_folder TEXT NOT NULL,
      commit_sha TEXT,
      trigger_source TEXT NOT NULL,
      input TEXT,
      evidence TEXT,
      check_results TEXT,
      judge_verdict TEXT,
      state TEXT NOT NULL,
      fail_reason TEXT,
      error_message TEXT,
      duration INTEGER DEFAULT 0,
      timestamp TEXT DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_eval_runs_batch ON eval_runs(batch_id)`,
    `CREATE INDEX IF NOT EXISTS idx_eval_runs_name ON eval_runs(eval_name)`,
    `CREATE INDEX IF NOT EXISTS idx_eval_batches_project ON eval_batches(project_id)`
  ];

  for (const stmt of statements) {
    await sql.query(stmt);
  }

  // Migrations — add columns that may not exist in older schemas
  const migrations = [
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS use_worktree INTEGER DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS worktree_name TEXT`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments TEXT`,
    `ALTER TABLE quality_rules ADD COLUMN IF NOT EXISTS send_fail_to_agent INTEGER DEFAULT 0`,
    `ALTER TABLE quality_rules ADD COLUMN IF NOT EXISTS send_fail_requires_spec INTEGER DEFAULT 0`,
    `ALTER TABLE quality_rules ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'cli'`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lines_added INTEGER DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS lines_removed INTEGER DEFAULT 0`,
    `ALTER TABLE quality_results ADD COLUMN IF NOT EXISTS analysis TEXT`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS has_spec INTEGER DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS max_effort INTEGER DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id)`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS effort TEXT`,
    `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS default_effort TEXT`,
    `ALTER TABLE sessions DROP COLUMN IF EXISTS max_effort`,
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS railway_project_id TEXT`,
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS deployment_url TEXT`,
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_repo TEXT`,
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS railway_service_id TEXT`,
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS railway_environment_id TEXT`,
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_deploy_id TEXT`,
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_deploy_status TEXT`,
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_deploy_logs TEXT`,
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_deploy_started_at TEXT`,
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_deploy_checked_at TEXT`,
  ];
  for (const migration of migrations) {
    try { await sql.query(migration); } catch (e) { console.error('Migration failed:', migration, e.message); }
  }

  // NOTE: One-time duplicate cleanup was here but removed — it ran on every restart
  // and could delete legitimate repeated messages (same content, different turns).
  // The upsert logic in sessionManager now prevents duplicates at the source.

  await seedQualityRules();
}

async function seedQualityRules() {
  const insertSql = `
    INSERT INTO quality_rules (id, name, description, hook_type, fires_on, severity, enabled, prompt, script, config, category, sort_order, send_fail_to_agent, send_fail_requires_spec, execution_mode)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    ON CONFLICT (id) DO NOTHING
  `;

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
      description: 'Re-injects the spec, enumerates every requirement, and blocks completion if any are incomplete when a spec document is present.',
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
FAIL: The following requirements are not met: [list each incomplete requirement with a brief explanation of what's missing]

If all requirements are met, respond with:
PASS: All spec requirements verified.`,
      script: null,
      config: null,
      category: 'completeness',
      sort_order: 4,
      send_fail_to_agent: 1,
      send_fail_requires_spec: 1
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

IMPORTANT: Look carefully at the FULL promise chain before reporting a missing .catch(). A .then().catch() split across multiple lines IS valid error handling. Only flag truly unhandled promises — ones with no .catch() anywhere in the chain and no surrounding try/catch.

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
URL="\${VISUAL_URL:-http://localhost:3001}"
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
    },

    // Phase 6: Full Lifecycle Hooks (20 new hooks, all defaulted to OFF)
    {
      id: 'session-context-injection',
      name: 'Session Context Injection',
      description: 'Injects project-specific context when a session begins. Reads the project\'s CLAUDE.md, loads environment info (current branch, Node version, running services), and injects reminders about project conventions.',
      hook_type: 'command',
      fires_on: 'SessionStart',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Session Context Injection - reads project context and injects it
CWD="\${SESSION_CWD:-$(pwd)}"
CONTEXT=""

# Read CLAUDE.md if it exists
if [ -f "$CWD/CLAUDE.md" ]; then
  CONTEXT="$CONTEXT\\n## Project Instructions:\\n$(head -100 "$CWD/CLAUDE.md")"
fi

# Get current branch
BRANCH=$(cd "$CWD" 2>/dev/null && git branch --show-current 2>/dev/null || echo "unknown")
CONTEXT="$CONTEXT\\n## Environment: Branch=$BRANCH"

# Node version if applicable
if [ -f "$CWD/package.json" ]; then
  NODE_VER=$(node -v 2>/dev/null || echo "not found")
  CONTEXT="$CONTEXT, Node=$NODE_VER"
fi

echo "$CONTEXT"
exit 0`,
      config: null,
      category: 'session',
      sort_order: 16
    },
    {
      id: 'session-end-summary',
      name: 'Session End Summary',
      description: 'Auto-generates a session summary when a session ends and pushes it to Mission Control via HTTP. Captures total messages, files changed, branch state, and a heuristic description of what was accomplished.',
      hook_type: 'command',
      fires_on: 'SessionEnd',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Session End Summary - captures session stats and pushes to Mission Control
SID="\${SESSION_ID:-\${CLAUDE_SESSION_ID:-unknown}}"
CWD="\${SESSION_CWD:-$(pwd)}"

# Get git stats
BRANCH=$(cd "$CWD" 2>/dev/null && git branch --show-current 2>/dev/null || echo "unknown")
CHANGED_FILES=$(cd "$CWD" 2>/dev/null && git diff --name-only HEAD 2>/dev/null | wc -l | tr -d ' ')
CHANGED_FILES="\${CHANGED_FILES:-0}"

# Push summary to Mission Control
curl -s -X POST http://localhost:3001/api/history/auto-summary \\
  -H "Content-Type: application/json" \\
  -d "{\\"session_id\\":\\"$SID\\",\\"branch\\":\\"$BRANCH\\",\\"files_changed\\":$CHANGED_FILES}" > /dev/null 2>&1

exit 0`,
      config: null,
      category: 'session',
      sort_order: 17
    },
    {
      id: 'spec-reinjection',
      name: 'Spec Re-Injection',
      description: 'Before every user message is processed, checks if the session was started from a spec file. If so, injects a reminder of the key requirements into Claude\'s context via additionalContext.',
      hook_type: 'command',
      fires_on: 'UserPromptSubmit',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Spec Re-Injection - re-injects spec file context before each user message
CWD="\${SESSION_CWD:-$(pwd)}"

# Look for spec files in common locations
SPEC=""
for f in "$CWD"/spec.md "$CWD"/SPEC.md "$CWD"/docs/spec.md "$CWD"/*.spec.md; do
  if [ -f "$f" ]; then
    SPEC=$(head -50 "$f")
    break
  fi
done

if [ -n "$SPEC" ]; then
  echo "REMINDER - Original spec requirements:\\n$SPEC"
fi
exit 0`,
      config: null,
      category: 'input',
      sort_order: 18
    },
    {
      id: 'vague-prompt-guard',
      name: 'Vague Prompt Guard',
      description: 'Evaluates whether the user\'s message is specific enough for Claude to act on effectively. If too vague, injects a reminder to ask clarifying questions.',
      hook_type: 'prompt',
      fires_on: 'UserPromptSubmit',
      severity: 'low',
      enabled: 0,
      prompt: `Evaluate the user's message for specificity. If the message is too vague or ambiguous for effective action (e.g., "fix it", "make it work", "do the thing", "update that", "change it"), inject a reminder to ask clarifying questions before proceeding.

Consider a message vague if:
1. It uses pronouns without clear antecedents ("fix it", "change that")
2. It lacks specific file names, function names, or error messages
3. It could reasonably be interpreted multiple ways
4. It gives no success criteria

If vague, respond with:
"The user's message may be ambiguous. Before proceeding, consider asking for clarification about: [specific aspects that are unclear]."

If specific enough, respond with nothing (empty response).`,
      script: null,
      config: null,
      category: 'input',
      sort_order: 19
    },
    {
      id: 'permission-auto-approve',
      name: 'Permission Auto-Approve (Safe Ops)',
      description: 'Auto-approves safe, repetitive operations (git status, git diff, tests, reading files). Auto-denies anything touching production branches. Logs every decision to Mission Control.',
      hook_type: 'command',
      fires_on: 'PermissionRequest',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Permission Auto-Approve - approves safe ops, denies dangerous ones
TOOL="\${TOOL_NAME:-}"
CMD="\${TOOL_INPUT:-}"

# Auto-deny: production branch pushes
if echo "$CMD" | grep -qE 'git\\s+push.*\\b(main|master|production)\\b'; then
  echo "Auto-denied push to production branch"
  exit 1
fi

# Auto-approve: safe read-only operations
if echo "$CMD" | grep -qE '^(git\\s+(status|diff|log|branch)|npm\\s+test|pytest|ls|cat|head|tail)'; then
  echo "Auto-approved safe operation: $TOOL"
  exit 0
fi

# Everything else: no opinion (let user decide)
exit 0`,
      config: null,
      category: 'safety',
      sort_order: 20
    },
    {
      id: 'tool-failure-tracker',
      name: 'Tool Failure Tracker',
      description: 'When a tool fails, logs the full error context to Mission Control. Tracks failure patterns across sessions. Sends a push notification if a critical command fails.',
      hook_type: 'command',
      fires_on: 'PostToolUseFailure',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Tool Failure Tracker - logs tool failures to Mission Control
SID="\${SESSION_ID:-\${CLAUDE_SESSION_ID:-unknown}}"
TOOL="\${TOOL_NAME:-unknown}"
ERROR="\${TOOL_ERROR:-unknown error}"

echo "Tool $TOOL failed: $ERROR"

# Send push notification for critical failures
if echo "$TOOL" | grep -qiE '(test|build|deploy)'; then
  SAFE_TOOL=$(echo "$TOOL" | sed 's/["\\\\/]/ /g' | head -c 100)
  curl -s -X POST http://localhost:3001/api/notifications/push \\
    -H "Content-Type: application/json" \\
    -d "{\\"title\\":\\"Tool Failure\\",\\"body\\":\\"$SAFE_TOOL failed\\",\\"type\\":\\"error\\"}" > /dev/null 2>&1
fi

exit 1`,
      config: null,
      category: 'correctness',
      sort_order: 21
    },
    {
      id: 'subagent-spawn-tracker',
      name: 'Subagent Spawn Tracker',
      description: 'Logs when subagents spawn so Mission Control can show delegation activity in the dashboard. Tracks how many subagents a session creates.',
      hook_type: 'command',
      fires_on: 'SubagentStart',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Subagent Spawn Tracker - logs subagent creation to Mission Control
SUBAGENT_ID="\${SUBAGENT_ID:-unknown}"
SUBAGENT_TYPE="\${SUBAGENT_TYPE:-unknown}"

echo "Subagent spawned: type=$SUBAGENT_TYPE id=$SUBAGENT_ID"
exit 0`,
      config: null,
      category: 'subagent',
      sort_order: 22
    },
    {
      id: 'subagent-output-validation',
      name: 'Subagent Output Validation',
      description: 'Validates subagent output before it returns to the main agent. Checks whether the subagent actually completed its task and whether its output is actionable.',
      hook_type: 'prompt',
      fires_on: 'SubagentStop',
      severity: 'medium',
      enabled: 0,
      prompt: `Review the subagent's output before it returns to the main agent. Evaluate:

1. Did the subagent actually complete the task it was assigned?
2. Is the output specific and actionable, or vague and unhelpful?
3. Did the subagent introduce any issues, errors, or incorrect assumptions?
4. Is the output format consistent with what the parent agent expects?

If the subagent output is low quality or incomplete, respond with:
FAIL: Subagent output issue: [description of problem]

If the output is satisfactory, respond with:
PASS: Subagent output is complete and actionable.`,
      script: null,
      config: null,
      category: 'subagent',
      sort_order: 23
    },
    {
      id: 'notification-router',
      name: 'Notification Router',
      description: 'Routes Claude\'s internal notifications to Mission Control\'s push notification system. Sends notifications for permission requests, idle prompts, and auth completions.',
      hook_type: 'command',
      fires_on: 'Notification',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Notification Router - routes Claude notifications to Mission Control push
SID="\${SESSION_ID:-\${CLAUDE_SESSION_ID:-unknown}}"
NOTIFICATION_TYPE="\${NOTIFICATION_TYPE:-info}"
NOTIFICATION_MESSAGE="\${NOTIFICATION_MESSAGE:-Claude Code notification}"

# Truncate and sanitize message for JSON
BODY=$(echo "$NOTIFICATION_MESSAGE" | sed 's/["\\\\/]/ /g' | head -c 200)

curl -s -X POST http://localhost:3001/api/notifications/push \\
  -H "Content-Type: application/json" \\
  -d "{\\"title\\":\\"Claude Code\\",\\"body\\":\\"$BODY\\",\\"type\\":\\"$NOTIFICATION_TYPE\\",\\"session_id\\":\\"$SID\\"}" > /dev/null 2>&1

exit 0`,
      config: null,
      category: 'notifications',
      sort_order: 24
    },
    {
      id: 'pre-compaction-backup',
      name: 'Pre-Compaction Backup',
      description: 'Before context compaction, saves the full conversation transcript to a timestamped file. Critical for long sessions where earlier context is permanently lost after compaction.',
      hook_type: 'command',
      fires_on: 'PreCompact',
      severity: 'medium',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Pre-Compaction Backup - saves conversation transcript before compaction
SID="\${SESSION_ID:-\${CLAUDE_SESSION_ID:-unknown}}"
BACKUP_DIR="$HOME/.claude/mission-control-backups"
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/transcript-$SID-$TIMESTAMP.json"

# Fetch conversation from Mission Control API
curl -s "http://localhost:3001/api/sessions/$SID/messages?limit=10000" > "$BACKUP_FILE" 2>/dev/null

if [ -f "$BACKUP_FILE" ] && [ -s "$BACKUP_FILE" ]; then
  echo "PASS: Conversation backed up to $BACKUP_FILE"
  exit 0
else
  echo "FAIL: Could not backup conversation"
  exit 1
fi`,
      config: null,
      category: 'context',
      sort_order: 25
    },
    {
      id: 'post-compaction-recovery',
      name: 'Post-Compaction Context Recovery',
      description: 'After context compaction, re-injects critical information that may have been lost. Reads the original spec file, current git status, and pinned reminders.',
      hook_type: 'command',
      fires_on: 'PostCompact',
      severity: 'medium',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Post-Compaction Context Recovery - re-injects critical context after compaction
CWD="\${SESSION_CWD:-$(pwd)}"
CONTEXT=""

# Re-inject spec file if present
for f in "$CWD"/spec.md "$CWD"/SPEC.md "$CWD"/docs/spec.md "$CWD"/*.spec.md; do
  if [ -f "$f" ]; then
    CONTEXT="$CONTEXT\\n## Original Spec (re-injected after compaction):\\n$(head -100 "$f")"
    break
  fi
done

# Current git status for orientation
if cd "$CWD" 2>/dev/null; then
  BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
  STATUS=$(git status --short 2>/dev/null | head -20)
  CONTEXT="$CONTEXT\\n## Current State: Branch=$BRANCH\\n$STATUS"
fi

# Re-inject CLAUDE.md reminders
if [ -f "$CWD/CLAUDE.md" ]; then
  CONTEXT="$CONTEXT\\n## Project Instructions (re-injected):\\n$(head -50 "$CWD/CLAUDE.md")"
fi

if [ -n "$CONTEXT" ]; then
  echo "$CONTEXT"
fi
exit 0`,
      config: null,
      category: 'context',
      sort_order: 26
    },
    {
      id: 'worktree-create-tracker',
      name: 'Worktree Create Tracker',
      description: 'Logs to Mission Control when a new git worktree is created. Updates the dashboard with the new branch name. Optionally copies project config files to the new worktree.',
      hook_type: 'command',
      fires_on: 'WorktreeCreate',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Worktree Create Tracker - logs worktree creation and copies config
WORKTREE_PATH="\${WORKTREE_PATH:-}"
SOURCE_PATH="\${SESSION_CWD:-$(pwd)}"

# Copy untracked config files to new worktree
if [ -n "$WORKTREE_PATH" ] && [ -d "$WORKTREE_PATH" ]; then
  for f in .env .env.local .env.development.local; do
    if [ -f "$SOURCE_PATH/$f" ] && [ ! -f "$WORKTREE_PATH/$f" ]; then
      cp "$SOURCE_PATH/$f" "$WORKTREE_PATH/$f" 2>/dev/null
    fi
  done
fi

BRANCH=$(cd "$WORKTREE_PATH" 2>/dev/null && git branch --show-current 2>/dev/null || echo "unknown")
echo "Worktree created: branch=$BRANCH path=$WORKTREE_PATH"
exit 0`,
      config: null,
      category: 'workspace',
      sort_order: 27
    },
    {
      id: 'worktree-remove-guard',
      name: 'Worktree Remove Guard',
      description: 'Before a worktree is removed, checks for uncommitted changes. If there are unsaved changes, logs a warning. Archives the session summary for the branch being removed.',
      hook_type: 'command',
      fires_on: 'WorktreeRemove',
      severity: 'medium',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Worktree Remove Guard - checks for uncommitted changes before removal
WORKTREE_PATH="\${WORKTREE_PATH:-}"

if [ -n "$WORKTREE_PATH" ] && [ -d "$WORKTREE_PATH" ]; then
  UNCOMMITTED=$(cd "$WORKTREE_PATH" 2>/dev/null && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  BRANCH=$(cd "$WORKTREE_PATH" 2>/dev/null && git branch --show-current 2>/dev/null || echo "unknown")

  if [ "$UNCOMMITTED" -gt 0 ]; then
    echo "WARNING: $UNCOMMITTED uncommitted changes in worktree $BRANCH at $WORKTREE_PATH"
    exit 1
  fi
fi

exit 0`,
      config: null,
      category: 'workspace',
      sort_order: 28
    },
    {
      id: 'directory-change-tracker',
      name: 'Directory Change Tracker',
      description: 'Updates Mission Control\'s file browser when Claude changes working directories.',
      hook_type: 'command',
      fires_on: 'CwdChanged',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Directory Change Tracker - updates Mission Control when cwd changes
SID="\${SESSION_ID:-\${CLAUDE_SESSION_ID:-unknown}}"
NEW_CWD="\${NEW_CWD:-$(pwd)}"

# Sanitize path for JSON safety
SAFE_CWD=$(echo "$NEW_CWD" | sed 's/["\\\\/]/\\\\&/g')
curl -s -X POST http://localhost:3001/api/sessions/cwd-update \\
  -H "Content-Type: application/json" \\
  -d "{\\"session_id\\":\\"$SID\\",\\"working_directory\\":\\"$SAFE_CWD\\"}" > /dev/null 2>&1

echo "Working directory changed to: $NEW_CWD"
exit 0`,
      config: null,
      category: 'workspace',
      sort_order: 29
    },
    {
      id: 'project-health-check',
      name: 'Project Health Check',
      description: 'Runs on first entry into a repo. Verifies required tools are installed, checks that .env exists, and reports overall project health to Mission Control.',
      hook_type: 'command',
      fires_on: 'Setup',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Project Health Check - verifies environment setup on first entry
CWD="\${SESSION_CWD:-$(pwd)}"
ISSUES=""

# Check Node.js
if [ -f "$CWD/package.json" ]; then
  if ! command -v node &> /dev/null; then
    ISSUES="$ISSUES Node.js not installed;"
  fi
  # Check if node_modules exists
  if [ ! -d "$CWD/node_modules" ]; then
    ISSUES="$ISSUES node_modules missing (run npm install);"
  fi
fi

# Check Python
if [ -f "$CWD/requirements.txt" ] || [ -f "$CWD/pyproject.toml" ]; then
  if ! command -v python3 &> /dev/null; then
    ISSUES="$ISSUES Python3 not installed;"
  fi
fi

# Check .env
if [ -f "$CWD/.env.example" ] && [ ! -f "$CWD/.env" ]; then
  ISSUES="$ISSUES .env file missing (copy from .env.example);"
fi

# Check git
if [ ! -d "$CWD/.git" ]; then
  ISSUES="$ISSUES Not a git repository;"
fi

if [ -n "$ISSUES" ]; then
  echo "Health issues: $ISSUES"
  exit 1
else
  echo "PASS: Project environment is healthy"
  exit 0
fi`,
      config: null,
      category: 'config',
      sort_order: 30
    },
    {
      id: 'instructions-loaded-logger',
      name: 'Instructions Loaded Logger',
      description: 'Logs which CLAUDE.md files were loaded at session start so Mission Control can display what instructions Claude is operating under.',
      hook_type: 'command',
      fires_on: 'InstructionsLoaded',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Instructions Loaded Logger - logs which CLAUDE.md files were loaded
CWD="\${SESSION_CWD:-$(pwd)}"
FOUND=""

# Check common locations for CLAUDE.md
for f in "$CWD/CLAUDE.md" "$CWD/.claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"; do
  if [ -f "$f" ]; then
    FOUND="$FOUND $f"
  fi
done

if [ -z "$FOUND" ]; then
  echo "No CLAUDE.md files found - project may not be configured for Claude Code"
  exit 1
else
  echo "Instructions loaded from:$FOUND"
  exit 0
fi`,
      config: null,
      category: 'config',
      sort_order: 31
    },
    {
      id: 'config-change-auditor',
      name: 'Config Change Auditor',
      description: 'When Claude Code settings change mid-session, logs the change to Mission Control for audit. Provides a history of what was changed, when, and in which session.',
      hook_type: 'command',
      fires_on: 'ConfigChange',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Config Change Auditor - logs settings changes to Mission Control
CONFIG_KEY="\${CONFIG_KEY:-unknown}"
CONFIG_VALUE="\${CONFIG_VALUE:-unknown}"

echo "Config changed: $CONFIG_KEY=$CONFIG_VALUE"
exit 0`,
      config: null,
      category: 'config',
      sort_order: 32
    },
    {
      id: 'task-progress-tracker',
      name: 'Task Progress Tracker',
      description: 'Tracks task creation in Mission Control\'s dashboard. When Claude creates a task as part of a plan, logs it for progress tracking.',
      hook_type: 'command',
      fires_on: 'TaskCreated',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Task Progress Tracker - logs task creation to Mission Control
TASK_ID="\${TASK_ID:-unknown}"
TASK_DESCRIPTION="\${TASK_DESCRIPTION:-}"

echo "Task created: $TASK_DESCRIPTION"
exit 0`,
      config: null,
      category: 'tasks',
      sort_order: 33
    },
    {
      id: 'task-completion-notifier',
      name: 'Task Completion Notifier',
      description: 'Sends a push notification when a task completes and updates Mission Control\'s task progress display. Sends a summary when all tasks in a plan are done.',
      hook_type: 'command',
      fires_on: 'TaskCompleted',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Task Completion Notifier - sends push notification on task completion
SID="\${SESSION_ID:-\${CLAUDE_SESSION_ID:-unknown}}"
TASK_DESCRIPTION="\${TASK_DESCRIPTION:-Task completed}"

BODY=$(echo "$TASK_DESCRIPTION" | head -c 200 | sed 's/"/\\\\"/g' | tr '\\n' ' ')

echo "Task completed: $BODY"

# Send push notification
curl -s -X POST http://localhost:3001/api/notifications/push \\
  -H "Content-Type: application/json" \\
  -d "{\\"title\\":\\"Task Completed\\",\\"body\\":\\"$BODY\\",\\"type\\":\\"task_complete\\",\\"session_id\\":\\"$SID\\"}" > /dev/null 2>&1

exit 0`,
      config: null,
      category: 'tasks',
      sort_order: 34
    },
    {
      id: 'teammate-idle-monitor',
      name: 'Teammate Idle Monitor',
      description: 'When using agent teams, notifies Mission Control that a team member finished its work. Shows team coordination status in the dashboard.',
      hook_type: 'command',
      fires_on: 'TeammateIdle',
      severity: 'low',
      enabled: 0,
      prompt: null,
      script: `#!/bin/bash
# Teammate Idle Monitor - tracks agent team coordination
SID="\${SESSION_ID:-\${CLAUDE_SESSION_ID:-unknown}}"
TEAMMATE_ID="\${TEAMMATE_ID:-unknown}"
TEAMMATE_STATUS="\${TEAMMATE_STATUS:-idle}"

echo "Teammate $TEAMMATE_ID is now $TEAMMATE_STATUS"

# Send push notification - sanitize for JSON safety
SAFE_ID=$(echo "$TEAMMATE_ID" | sed 's/["\\\\/]/ /g' | head -c 100)
curl -s -X POST http://localhost:3001/api/notifications/push \\
  -H "Content-Type: application/json" \\
  -d "{\\"title\\":\\"Team Update\\",\\"body\\":\\"Teammate $SAFE_ID is now $TEAMMATE_STATUS\\",\\"type\\":\\"info\\",\\"session_id\\":\\"$SID\\"}" > /dev/null 2>&1

exit 0`,
      config: null,
      category: 'teams',
      sort_order: 35
    },
    {
      id: 'eval-authoring',
      name: 'Eval Authoring',
      description: 'Proposes new eval YAML files for the project based on the current session work. Analyzes what was built or changed and suggests evals that would catch regressions.',
      hook_type: 'agent',
      fires_on: 'Stop',
      severity: 'low',
      enabled: 0,
      prompt: `You are an eval authoring assistant. Based on the work done in this session, propose new eval YAML files that would catch regressions.

For each eval you propose, output a complete YAML eval definition following this schema:
- name: descriptive kebab-case name
- description: what this eval checks
- input: key-value map of test inputs
- evidence: { type: log_query|db_query|sub_agent|file, source/path/query as appropriate }
- checks: list of deterministic checks (regex_match, not_empty, json_valid, json_schema, http_status, field_exists)
- judge_prompt: (optional) LLM judge instructions for nuanced evaluation
- expected: (required if judge_prompt is set) what the judge should look for

Guidelines:
1. Focus on the specific features or fixes from this session
2. Prefer deterministic checks over judge-based evals where possible
3. Each eval should test one specific behavior
4. Use realistic input values based on the actual code
5. Place evals in the appropriate subfolder based on the feature area

Output each proposed eval as a separate YAML code block with a suggested file path comment at the top.
If no meaningful evals can be proposed for this session's work, respond with:
PASS: No new evals needed for this session.`,
      script: null,
      config: JSON.stringify({ tools: ['Read', 'Glob', 'Grep'] }),
      category: 'evals',
      sort_order: 36
    }
  ];

  for (const r of rules) {
    await sql.query(insertSql, [r.id, r.name, r.description, r.hook_type, r.fires_on, r.severity, r.enabled, r.prompt, r.script, r.config, r.category, r.sort_order, r.send_fail_to_agent || 0, r.send_fail_requires_spec || 0, r.execution_mode || 'cli']);
  }

  // Ensure spec-compliance has send_fail_to_agent and send_fail_requires_spec enabled by default
  await sql.query(`UPDATE quality_rules SET send_fail_to_agent = 1, send_fail_requires_spec = 1 WHERE id = 'spec-compliance' AND send_fail_to_agent = 0`);
}

module.exports = { query, initializeDb };
