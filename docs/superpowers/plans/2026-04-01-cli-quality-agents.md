# CLI-Based Quality Check Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace paid LLM Gateway API calls with free `claude --print` CLI subprocesses for quality checks, with per-rule routing via `execution_mode`.

**Architecture:** Add `execution_mode` column to `quality_rules` (default `'cli'`). New `cliAgent.js` service wraps `claude --print` subprocess spawning. `qualityRunner.js` routes checks through CLI or API based on each rule's mode. Frontend gets a toggle per rule.

**Tech Stack:** Node.js child_process, Claude CLI (`claude --print`), Express, React, PostgreSQL

---

### Task 1: Add `execution_mode` column to database schema

**Files:**
- Modify: `server/database.js:66-72` (CREATE TABLE schema)
- Modify: `server/database.js:96-102` (migrations array)
- Modify: `server/database.js:110-115` (seed INSERT statement)

- [ ] **Step 1: Add `execution_mode` to the CREATE TABLE statement**

In `server/database.js`, find the `quality_rules` CREATE TABLE statement (line 66) and add the column after `send_fail_requires_spec`:

```sql
execution_mode TEXT DEFAULT 'cli',
```

So the full statement becomes:
```sql
CREATE TABLE IF NOT EXISTS quality_rules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
  hook_type TEXT NOT NULL, fires_on TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'medium',
  enabled INTEGER DEFAULT 1, prompt TEXT, script TEXT, config TEXT, category TEXT,
  send_fail_to_agent INTEGER DEFAULT 0, send_fail_requires_spec INTEGER DEFAULT 0,
  execution_mode TEXT DEFAULT 'cli',
  sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT NOW(), updated_at TEXT DEFAULT NOW()
)
```

- [ ] **Step 2: Add migration for existing databases**

In the `migrations` array (line 96), add:

```javascript
`ALTER TABLE quality_rules ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'cli'`,
```

- [ ] **Step 3: Update the seed INSERT statement to include `execution_mode`**

Update the `insertSql` in `seedQualityRules()` (line 111) to include the new column:

```javascript
const insertSql = `
  INSERT INTO quality_rules (id, name, description, hook_type, fires_on, severity, enabled, prompt, script, config, category, sort_order, send_fail_to_agent, send_fail_requires_spec, execution_mode)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  ON CONFLICT (id) DO NOTHING
`;
```

Then update every rule object in the `rules` array to include `execution_mode: 'cli'`. Each rule's values array also needs the 15th parameter. Find where the values are mapped into the INSERT call and add `rule.execution_mode || 'cli'` as the 15th value.

- [ ] **Step 4: Commit**

```bash
git add server/database.js
git commit -m "feat: add execution_mode column to quality_rules schema"
```

---

### Task 2: Create `cliAgent.js` service

**Files:**
- Create: `server/services/cliAgent.js`

- [ ] **Step 1: Create the CLI agent service**

Create `server/services/cliAgent.js`:

```javascript
/**
 * CLI Agent — runs prompts via `claude --print` subprocess.
 *
 * Uses the Claude CLI on the user's Max plan instead of the paid
 * LLM Gateway API. Each call spawns a short-lived subprocess that
 * takes a prompt on stdin and returns the response on stdout.
 */

const { execFile } = require('child_process');

/**
 * Run a prompt via the Claude CLI and return the text response.
 *
 * @param {string} prompt - The full prompt to send
 * @returns {Promise<string>} The CLI's text output
 */
function run(prompt) {
  return new Promise((resolve, reject) => {
    const child = execFile('claude', ['--print', '-p', prompt], {
      maxBuffer: 1024 * 1024, // 1MB
      timeout: 120000, // 2 minutes
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`CLI agent failed: ${error.message}`));
        return;
      }
      resolve(stdout || '');
    });
  });
}

module.exports = { run };
```

- [ ] **Step 2: Commit**

```bash
git add server/services/cliAgent.js
git commit -m "feat: add cliAgent service wrapping claude --print"
```

---

### Task 3: Update `qualityRunner.js` to route by `execution_mode`

**Files:**
- Modify: `server/services/qualityRunner.js:1-12` (imports)
- Modify: `server/services/qualityRunner.js:98-128` (runQualityCheck)
- Modify: `server/services/qualityRunner.js:135-178` (runSpecComplianceCheck)

- [ ] **Step 1: Add the cliAgent import**

At the top of `server/services/qualityRunner.js`, after the existing `chatCompletion` import (line 10), add:

```javascript
const { run: cliRun } = require('./cliAgent');
```

- [ ] **Step 2: Update `runQualityCheck` to branch on `execution_mode`**

Replace the body of `runQualityCheck` (lines 98-128) with:

```javascript
async function runQualityCheck(rule, context) {
  try {
    const prompt = `${rule.prompt}

Context about what just happened:
${context}

IMPORTANT: After your evaluation, report the result by including one of these markers at the very end of your response:
QUALITY_RESULT:${rule.id}:${rule.severity}:PASS
or
QUALITY_RESULT:${rule.id}:${rule.severity}:FAIL:[brief reason]`;

    let fullText;

    if (rule.execution_mode === 'cli') {
      fullText = await cliRun(
        `You are a code quality reviewer. Be concise. Evaluate the code change and report PASS or FAIL with the exact QUALITY_RESULT marker format requested.\n\n${prompt}`
      ) || '';
    } else {
      fullText = await chatCompletion({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: 'You are a code quality reviewer. Be concise. Evaluate the code change and report PASS or FAIL with the exact QUALITY_RESULT marker format requested.',
        messages: [{ role: 'user', content: prompt }],
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
    console.error(`[QualityRunner] Error running check ${rule.id}:`, e.message);
    return null;
  }
}
```

- [ ] **Step 3: Update `runSpecComplianceCheck` to branch on `execution_mode`**

Replace the LLM call inside `runSpecComplianceCheck` (lines 161-166) with:

```javascript
    let fullText;

    if (rule.execution_mode === 'cli') {
      fullText = await cliRun(
        `You are a strict spec compliance reviewer. Be thorough — enumerate every requirement from the spec and check each one. Do not give the benefit of the doubt. If you cannot confirm a requirement was implemented from the conversation context, mark it incomplete.\n\n${prompt}`
      ) || '';
    } else {
      fullText = await chatCompletion({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: 'You are a strict spec compliance reviewer. Be thorough — enumerate every requirement from the spec and check each one. Do not give the benefit of the doubt. If you cannot confirm a requirement was implemented from the conversation context, mark it incomplete.',
        messages: [{ role: 'user', content: prompt }],
      }) || '';
    }
```

Everything else in `runSpecComplianceCheck` (the prompt construction above and result parsing below) stays the same.

- [ ] **Step 4: Commit**

```bash
git add server/services/qualityRunner.js
git commit -m "feat: route quality checks through CLI or API based on execution_mode"
```

---

### Task 4: Add API endpoint for updating `execution_mode`

**Files:**
- Modify: `server/routes/quality.js` (add new route after the severity route, around line 82)

- [ ] **Step 1: Add the endpoint**

After the `PUT /rules/:id/severity` route (line 82), add:

```javascript
// Update rule execution mode (cli or api)
router.put('/rules/:id/execution-mode', async (req, res) => {
  const { mode } = req.body;
  if (!['cli', 'api'].includes(mode)) {
    return res.status(400).json({ error: 'Mode must be cli or api' });
  }

  await query('UPDATE quality_rules SET execution_mode = $1, updated_at = NOW() WHERE id = $2',
    [mode, req.params.id]);

  const { rows } = await query('SELECT * FROM quality_rules WHERE id = $1', [req.params.id]);
  const rule = rows[0];
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  res.json(rule);
});
```

- [ ] **Step 2: Commit**

```bash
git add server/routes/quality.js
git commit -m "feat: add PUT endpoint for quality rule execution mode"
```

---

### Task 5: Add execution mode toggle to `RulesConfig.jsx`

**Files:**
- Modify: `client/src/components/Quality/RulesConfig.jsx` (add handler + UI toggle)
- Modify: `client/src/components/Quality/RulesConfig.module.css` (add styles)

- [ ] **Step 1: Add the `updateExecutionMode` handler**

In `RulesConfig.jsx`, after the `toggleSendFailRequiresSpec` handler (around line 105), add:

```javascript
const updateExecutionMode = async (ruleId, mode) => {
  try {
    await api.put(`/api/quality/rules/${ruleId}/execution-mode`, { mode });
    await loadRules();
  } catch (e) {}
};
```

- [ ] **Step 2: Add the execution mode toggle to the expanded rule body**

In the expanded rule body section (inside the `isExpanded &&` block, around line 265), add the execution mode toggle after the rule description paragraph and before the `sendFailRow` div:

```jsx
<div className={styles.executionModeRow}>
  <span className={styles.executionModeLabel}>Execution</span>
  <div className={styles.executionModePicker}>
    <button
      className={`${styles.modeBtn} ${rule.execution_mode !== 'api' ? styles.modeActive : ''}`}
      onClick={() => updateExecutionMode(rule.id, 'cli')}
    >
      <Terminal size={12} /> CLI
    </button>
    <button
      className={`${styles.modeBtn} ${rule.execution_mode === 'api' ? styles.modeActive : ''}`}
      onClick={() => updateExecutionMode(rule.id, 'api')}
    >
      <Zap size={12} /> API
    </button>
  </div>
</div>
```

- [ ] **Step 3: Add CSS for the execution mode controls**

In `RulesConfig.module.css`, add at the end:

```css
.executionModeRow {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.executionModeLabel {
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 600;
  min-width: 70px;
}

.executionModePicker {
  display: flex;
  gap: 4px;
}

.modeBtn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.modeBtn:hover {
  border-color: var(--text-secondary);
  color: var(--text-secondary);
}

.modeActive {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
}
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/Quality/RulesConfig.jsx client/src/components/Quality/RulesConfig.module.css
git commit -m "feat: add CLI/API execution mode toggle to rules config UI"
```

---

### Task 6: Manual smoke test

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

- [ ] **Step 2: Verify the database migration ran**

Check the server logs for migration output. Open the Rules Config page in the browser and confirm all rules show the CLI/API toggle defaulting to CLI.

- [ ] **Step 3: Toggle a rule to API mode and back**

Click the API button on any rule, refresh the page, confirm it persisted. Click CLI to switch it back.

- [ ] **Step 4: Trigger a quality check**

Start a session and make a file edit to trigger a PostToolUse quality check. Watch the server logs for `[QualityRunner]` output. Confirm it spawns a `claude --print` process instead of calling the LLM Gateway.

- [ ] **Step 5: Switch one rule to API mode and trigger it**

Set one rule to API mode, trigger it, and confirm the server logs show it going through the LLM Gateway as before.
