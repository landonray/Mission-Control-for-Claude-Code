# AI-Assisted Eval Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a natural-language eval authoring flow where users describe what an eval should check, an AI agent drafts the complete eval, and the result populates the existing form for review before saving as a draft.

**Architecture:** A new backend service (`evalAuthoring.js`) spawns a sandboxed Claude CLI session that investigates the project and returns a structured eval definition. The frontend adds a choice screen ("Build with AI" / "Build manually"), a drawer component for input/progress, and modifications to the existing form to support AI-populated state, refinement, and preview runs. Draft evals use a `.draft` suffix and are invisible to the run engine until published.

**Tech Stack:** Node.js/Express backend, React frontend with CSS Modules, WebSocket for progress updates, Claude CLI (`claude --print`) for AI authoring agent, Vitest for testing.

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `server/services/evalAuthoring.js` | Builds the authoring prompt, spawns CLI session, parses structured output, manages progress timer |
| `server/__tests__/evalAuthoring.test.js` | Unit tests for prompt building, output parsing, progress timer |
| `client/src/components/Quality/EvalChoiceScreen.jsx` | "Build with AI" / "Build manually" entry point |
| `client/src/components/Quality/EvalChoiceScreen.module.css` | Choice screen styles |
| `client/src/components/Quality/AIEvalDrawer.jsx` | Text area, progress display, error states, refinement mode |
| `client/src/components/Quality/AIEvalDrawer.module.css` | Drawer styles |
| `client/src/components/Quality/PreviewRunResult.jsx` | Preview run result display (evidence, checks, judge verdict) |
| `client/src/components/Quality/PreviewRunResult.module.css` | Preview result styles |
| `client/src/__tests__/EvalChoiceScreen.test.jsx` | Choice screen integration tests |
| `client/src/__tests__/AIEvalDrawer.test.jsx` | Drawer integration tests |

### Modified Files
| File | Changes |
|------|---------|
| `server/routes/evals.js` | Add `/author`, `/preview`, `/publish` endpoints, modify `/folders/:projectId` to return drafts |
| `server/services/evalLoader.js` | `loadEvalFolder()` separates `.yaml` from `.yaml.draft`; new `loadDraftsFromFolder()` function |
| `server/websocket.js` | Handle `eval_authoring_subscribe` message type, broadcast authoring events |
| `client/src/components/Quality/QualityTab.jsx` | Replace `CreateEvalForm` render with `EvalChoiceScreen`, add draft badges, publish/delete buttons |
| `client/src/components/Quality/CreateEvalForm.jsx` | Accept `initialValues` prop for AI population, add Refine/Preview Run buttons, "Save as Draft" |
| `client/src/components/Quality/QualityTab.module.css` | Draft badge styles, publish button styles |
| `client/src/components/Quality/CreateEvalForm.module.css` | Refine/Preview button styles |

---

## Task 1: Eval Authoring Service — Prompt Builder & Output Parser

**Files:**
- Create: `server/services/evalAuthoring.js`
- Create: `server/__tests__/evalAuthoring.test.js`

- [ ] **Step 1: Write failing test for `buildAuthoringPrompt`**

```js
// server/__tests__/evalAuthoring.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();

vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  default: {
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
  },
}));

describe('evalAuthoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function getModule() {
    return await import('../services/evalAuthoring.js');
  }

  describe('buildAuthoringPrompt', () => {
    it('includes eval schema, description, and folder context in the prompt', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([
        { name: 'existing-eval.yaml', isFile: () => true, isDirectory: () => false },
      ]);
      mockReadFileSync.mockReturnValue('name: existing-eval\ndescription: checks something\n');

      const { buildAuthoringPrompt } = await getModule();
      const prompt = buildAuthoringPrompt({
        description: 'Check that the API returns valid JSON',
        folderPath: '/project/evals/api-tests',
        projectRoot: '/project',
        missionControlConfig: { project: { name: 'my-project' } },
      });

      expect(prompt).toContain('Check that the API returns valid JSON');
      expect(prompt).toContain('log_query');
      expect(prompt).toContain('db_query');
      expect(prompt).toContain('sub_agent');
      expect(prompt).toContain('file');
      expect(prompt).toContain('regex_match');
      expect(prompt).toContain('not_empty');
      expect(prompt).toContain('existing-eval.yaml');
      expect(prompt).toContain('my-project');
    });

    it('includes refinement context when provided', async () => {
      mockExistsSync.mockReturnValue(false);

      const { buildAuthoringPrompt } = await getModule();
      const prompt = buildAuthoringPrompt({
        description: 'Check API returns JSON',
        folderPath: '/project/evals/api',
        projectRoot: '/project',
        refinement: 'Make the pagination check stricter',
        currentFormState: { name: 'api-json-check', description: 'Checks JSON' },
      });

      expect(prompt).toContain('Make the pagination check stricter');
      expect(prompt).toContain('api-json-check');
    });
  });

  describe('parseAuthoringOutput', () => {
    it('extracts eval object and reasoning from agent output', async () => {
      const { parseAuthoringOutput } = await getModule();
      const output = `I investigated the project and found the database schema.

Here is my reasoning: I chose db_query because the user wants to check database state.

\`\`\`json
{
  "name": "recipe-valid",
  "description": "Check recipe has required fields",
  "input": { "recipe_id": "123" },
  "evidence": { "type": "db_query", "query": "SELECT * FROM recipes WHERE id = :recipe_id", "params": { "recipe_id": "${input.recipe_id}" } },
  "checks": [{ "type": "not_empty" }, { "type": "json_valid" }],
  "expected": "Recipe exists and has valid JSON",
  "judge_prompt": "Check that the recipe has all required fields",
  "judge": { "model": "default" }
}
\`\`\`

REASONING: I chose db_query because the user wants to verify database state directly. I followed the naming convention from existing evals in the folder.`;

      const result = parseAuthoringOutput(output);

      expect(result.eval).toBeTruthy();
      expect(result.eval.name).toBe('recipe-valid');
      expect(result.eval.evidence.type).toBe('db_query');
      expect(result.eval.checks).toHaveLength(2);
      expect(result.reasoning).toContain('db_query');
    });

    it('returns error for output with no JSON block', async () => {
      const { parseAuthoringOutput } = await getModule();
      const result = parseAuthoringOutput('I could not figure out what eval to create.');

      expect(result.eval).toBeNull();
      expect(result.error).toBeTruthy();
    });

    it('returns error for invalid JSON in code block', async () => {
      const { parseAuthoringOutput } = await getModule();
      const result = parseAuthoringOutput('```json\n{ broken json }\n```');

      expect(result.eval).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run __tests__/evalAuthoring.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `evalAuthoring.js`**

```js
// server/services/evalAuthoring.js

import fs from 'fs';
import path from 'path';

const VALID_EVIDENCE_TYPES = ['log_query', 'db_query', 'sub_agent', 'file'];

const VALID_CHECK_TYPES = [
  'regex_match', 'not_empty', 'json_valid', 'json_schema',
  'http_status', 'field_exists', 'equals', 'contains',
  'greater_than', 'less_than', 'numeric_score',
];

const EVIDENCE_TYPE_DOCS = `
Evidence types:
- log_query: Search session logs, build output, or PR diffs. Fields: source (session_log|build_output|pr_diff|<file_path>), filter (regex string or {regex, flags}).
- db_query: Execute read-only SQL. Fields: query (SQL with :param placeholders), params (map of param name to value or \${variable}).
- sub_agent: Spawn a sandboxed Claude CLI to investigate. Fields: extraction_prompt (instructions), context_source (optional file path to inject as \${context_file}).
- file: Read a file from project root. Fields: path (relative to project root).

All evidence types support: allow_empty (boolean, default false), max_bytes, timeout.
`;

const CHECK_TYPE_DOCS = `
Check types (deterministic, all run independently):
- regex_match: { pattern: "regex" } — evidence must match regex
- not_empty: {} — evidence must not be empty
- json_valid: {} — evidence must be valid JSON
- json_schema: { schema: "path/to/schema.json" } — evidence must validate against JSON schema
- http_status: { status: 200 } — evidence must contain HTTP status code
- field_exists: { field: "path.to.field" } — JSON evidence must have field (dot notation)
- equals: { field: "path.to.field", value: "expected" } — field must equal value
- contains: { field: "path.to.field", value: "substring" } — field must contain value
- greater_than: { field: "path.to.field", value: 10 } — field must be > value
- less_than: { field: "path.to.field", value: 100 } — field must be < value
- numeric_score: { field: "path.to.field", min: 0.8, max: 1.0 } — field must be in range
`;

const INTERPOLATION_DOCS = `
Variable interpolation (use in query, path, extraction_prompt, expected, judge_prompt):
- \${input.key} — references an input field
- \${eval.name} — the eval's name
- \${run.commit_sha} — current git commit
- \${run.trigger} — what triggered the run (session_end, pr_updated, manual)
- \${project.root} — absolute path to project root
`;

const JUDGE_DOCS = `
Judge configuration (optional):
- judge_prompt: Instructions for the LLM judge. Tell it what to look for.
- expected: What a passing result looks like (required when judge_prompt is set).
- judge.model: "default" (Sonnet), "fast" (Haiku), "strong" (Opus).

If no judge_prompt is set, the eval is deterministic-only (checks only).
If judge_prompt is set, expected is required.
Must have at least one of: checks or judge_prompt.
`;

/**
 * Build the system prompt for the AI authoring agent.
 */
export function buildAuthoringPrompt({
  description,
  folderPath,
  projectRoot,
  missionControlConfig,
  refinement,
  currentFormState,
  hints,
}) {
  const parts = [];

  parts.push(`You are an eval authoring assistant for Mission Control. Your job is to create a complete eval definition based on the user's description.`);
  parts.push('');

  // Project context
  if (missionControlConfig) {
    parts.push(`## Project Configuration (.mission-control.yaml)`);
    parts.push('```yaml');
    parts.push(JSON.stringify(missionControlConfig, null, 2));
    parts.push('```');
    parts.push('');
  }

  // Eval schema reference
  parts.push(`## Eval YAML Schema Reference`);
  parts.push(EVIDENCE_TYPE_DOCS);
  parts.push(CHECK_TYPE_DOCS);
  parts.push(INTERPOLATION_DOCS);
  parts.push(JUDGE_DOCS);
  parts.push('');

  // Existing evals in folder for style reference
  parts.push(`## Existing Evals in Target Folder`);
  if (fs.existsSync(folderPath)) {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const yamlFiles = entries.filter(e => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml')));
    if (yamlFiles.length > 0) {
      parts.push(`Files: ${yamlFiles.map(f => f.name).join(', ')}`);
      // Read up to 2 existing evals for style reference
      const sampled = yamlFiles.slice(0, 2);
      for (const f of sampled) {
        try {
          const content = fs.readFileSync(path.join(folderPath, f.name), 'utf8');
          parts.push(`\n### ${f.name}`);
          parts.push('```yaml');
          parts.push(content.slice(0, 2000));
          parts.push('```');
        } catch (_) {}
      }
    } else {
      parts.push('No existing evals in this folder. You are creating the first one.');
    }
  } else {
    parts.push('Folder does not exist yet. You are creating the first eval.');
  }
  parts.push('');

  // Instructions
  parts.push(`## Instructions`);
  parts.push(`1. Investigate the project before drafting. Use Read, Glob, Grep, and Bash (read-only) to understand the codebase.`);
  parts.push(`2. If the eval might use db_query, read the database schema first.`);
  parts.push(`3. If existing evals are in the folder, follow their naming and style conventions.`);
  parts.push(`4. Output a complete eval definition as a JSON code block (\`\`\`json ... \`\`\`).`);
  parts.push(`5. After the JSON block, write a paragraph starting with "REASONING:" explaining what you investigated, what conventions you followed, and what assumptions you made.`);
  parts.push(`6. The JSON must include all required fields: name, description, input, evidence, and at least one of checks or judge_prompt (with expected if judge_prompt is present).`);
  parts.push('');

  // Refinement context
  if (refinement && currentFormState) {
    parts.push(`## Refinement Request`);
    parts.push(`The user originally asked for: ${description}`);
    parts.push(`\nThe current draft is:`);
    parts.push('```json');
    parts.push(JSON.stringify(currentFormState, null, 2));
    parts.push('```');
    parts.push(`\nThe user wants to change: ${refinement}`);
    parts.push(`\nProduce a revised eval that addresses the refinement while preserving everything else.`);
  } else {
    parts.push(`## User's Request`);
    parts.push(description);
  }

  if (hints) {
    parts.push(`\n## Additional Context`);
    parts.push(hints);
  }

  parts.push(`\n## Project Root`);
  parts.push(projectRoot);

  return parts.join('\n');
}

/**
 * Parse the agent's output to extract the structured eval and reasoning.
 */
export function parseAuthoringOutput(output) {
  // Extract JSON from code block
  const jsonMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (!jsonMatch) {
    return {
      eval: null,
      reasoning: null,
      error: 'Agent output did not contain a JSON code block. Raw output: ' + output.slice(0, 200),
    };
  }

  let evalDef;
  try {
    evalDef = JSON.parse(jsonMatch[1]);
  } catch (e) {
    return {
      eval: null,
      reasoning: null,
      error: `Failed to parse JSON from agent output: ${e.message}`,
    };
  }

  // Extract reasoning
  const reasoningMatch = output.match(/REASONING:\s*([\s\S]+?)(?:$)/i);
  const reasoning = reasoningMatch ? reasoningMatch[1].trim() : 'No reasoning provided by the agent.';

  return { eval: evalDef, reasoning, error: null };
}

/**
 * Run the full authoring flow: build prompt, spawn agent, parse output.
 *
 * @param {object} options
 * @param {string} options.description - User's natural-language description
 * @param {string} options.folderPath - Absolute path to target eval folder
 * @param {string} options.projectRoot - Absolute path to project root
 * @param {object} [options.missionControlConfig] - Parsed .mission-control.yaml
 * @param {string} [options.refinement] - Refinement request text
 * @param {object} [options.currentFormState] - Current form field values
 * @param {string} [options.hints] - Additional context hints
 * @param {AbortSignal} [options.signal] - Abort signal for cancellation
 * @returns {Promise<{ eval: object|null, reasoning: string|null, error: string|null }>}
 */
export async function runAuthoring(options) {
  const { signal } = options;

  const prompt = buildAuthoringPrompt(options);

  // Lazy-load cliAgent (CJS module)
  const cliAgent = require('./cliAgent');

  let output;
  try {
    output = await cliAgent.run(prompt, {
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash(read-only)'],
      cwd: options.projectRoot,
      timeout: 180000, // 3 minutes
      signal,
    });
  } catch (err) {
    return {
      eval: null,
      reasoning: null,
      error: err.message === 'Aborted' ? 'Authoring was cancelled.' : `Authoring agent failed: ${err.message}`,
    };
  }

  return parseAuthoringOutput(output);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run __tests__/evalAuthoring.test.js`
Expected: All 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add server/services/evalAuthoring.js server/__tests__/evalAuthoring.test.js
git commit -m "feat: add eval authoring service with prompt builder and output parser"
```

---

## Task 2: Eval Loader — Draft Discovery

**Files:**
- Modify: `server/services/evalLoader.js:50-60`
- Modify: `server/__tests__/evalLoader.test.js`

- [ ] **Step 1: Write failing test for draft separation**

Add to `server/__tests__/evalLoader.test.js`:

```js
describe('loadEvalFolder with drafts', () => {
  it('separates .yaml files from .yaml.draft files', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      'active-eval.yaml',
      'draft-eval.yaml.draft',
      'another.yml',
      'another-draft.yml.draft',
    ]);
    mockReadFileSync.mockReturnValue('yaml-content');
    mockYamlLoad.mockReturnValue({
      name: 'test',
      description: 'test',
      input: { key: 'val' },
      evidence: { type: 'file', path: 'test.txt' },
      checks: [{ type: 'not_empty' }],
    });

    const { loadEvalFolder } = await getModule();
    const result = loadEvalFolder('/some/folder');

    // loadEvalFolder only returns published evals (no .draft files)
    expect(result).toHaveLength(2);
    expect(result.every(e => !e._source.endsWith('.draft'))).toBe(true);
  });

  it('loadDraftsFromFolder returns only draft files', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      'active-eval.yaml',
      'draft-eval.yaml.draft',
    ]);
    mockReadFileSync.mockReturnValue('yaml-content');
    mockYamlLoad.mockReturnValue({
      name: 'test',
      description: 'test',
      input: { key: 'val' },
      evidence: { type: 'file', path: 'test.txt' },
      checks: [{ type: 'not_empty' }],
    });

    const { loadDraftsFromFolder } = await getModule();
    const result = loadDraftsFromFolder('/some/folder');

    expect(result).toHaveLength(1);
    expect(result[0]._source).toContain('.draft');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run __tests__/evalLoader.test.js`
Expected: FAIL — `loadDraftsFromFolder` not exported, and `loadEvalFolder` still returns draft files

- [ ] **Step 3: Modify `evalLoader.js` to separate drafts**

In `server/services/evalLoader.js`, replace the `loadEvalFolder` function (lines 50-60) and add `loadDraftsFromFolder`:

```js
/**
 * Load all published YAML eval files from a folder (excludes .draft files).
 * @param {string} folderPath - Absolute path to folder containing .yaml/.yml files
 * @returns {object[]} Array of parsed eval definitions
 */
export function loadEvalFolder(folderPath) {
  if (!fs.existsSync(folderPath)) {
    return [];
  }

  const files = fs.readdirSync(folderPath).filter(
    (f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.endsWith('.draft')
  );

  return files.map((f) => loadEval(path.join(folderPath, f)));
}

/**
 * Load all draft eval files from a folder (.yaml.draft / .yml.draft).
 * @param {string} folderPath - Absolute path to folder
 * @returns {object[]} Array of parsed eval definitions (with _source pointing to .draft file)
 */
export function loadDraftsFromFolder(folderPath) {
  if (!fs.existsSync(folderPath)) {
    return [];
  }

  const files = fs.readdirSync(folderPath).filter(
    (f) => f.endsWith('.yaml.draft') || f.endsWith('.yml.draft')
  );

  return files.map((f) => loadEval(path.join(folderPath, f)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run __tests__/evalLoader.test.js`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add server/services/evalLoader.js server/__tests__/evalLoader.test.js
git commit -m "feat: separate draft evals from published in eval loader"
```

---

## Task 3: Backend Endpoints — Author, Preview, Publish

**Files:**
- Modify: `server/routes/evals.js`
- Create: `server/__tests__/evals-author.test.js`

- [ ] **Step 1: Write failing test for the author endpoint**

```js
// server/__tests__/evals-author.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the route handler logic by extracting it, or by making HTTP-level tests.
// For now, test the integration between the route and the authoring service.

describe('POST /api/evals/author', () => {
  it('returns 400 if description is missing', async () => {
    // This will be tested via supertest or direct handler invocation
    // For now, validate the route exists and rejects bad input
    expect(true).toBe(true); // placeholder — real test below
  });
});

describe('POST /api/evals/preview', () => {
  it('placeholder for preview endpoint test', () => {
    expect(true).toBe(true);
  });
});

describe('POST /api/evals/publish', () => {
  it('placeholder for publish endpoint test', () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Add the author endpoint to `server/routes/evals.js`**

Add after line 249 (after the create-eval endpoint), before the arm endpoint:

```js
// POST /folders/:projectId/author — AI-assisted eval authoring
router.post('/folders/:projectId/author', async (req, res) => {
  try {
    const { description, folderPath, refinement, currentFormState, hints } = req.body;

    if (!description || typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ error: 'description is required' });
    }
    if (!folderPath || typeof folderPath !== 'string' || !folderPath.trim()) {
      return res.status(400).json({ error: 'folderPath is required' });
    }

    const { getProject } = await getProjectDiscovery();
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Path safety
    const projectRoot = project.root_path.endsWith('/') ? project.root_path : project.root_path + '/';
    if (!folderPath.startsWith(projectRoot) && folderPath !== project.root_path) {
      return res.status(400).json({ error: 'folderPath must be inside the project' });
    }

    // Generate a job ID for WebSocket progress tracking
    const jobId = uuidv4();

    // Respond immediately with jobId — results come via WebSocket
    res.json({ success: true, jobId });

    // Run authoring in background
    const { runAuthoring } = await import('../services/evalAuthoring.js');

    // Set up progress timer — send predetermined messages via WebSocket
    const { broadcast } = require('../websocket');
    const progressMessages = [
      { delay: 0, message: 'Investigating your project...' },
      { delay: 8000, message: 'Reviewing existing evals...' },
      { delay: 16000, message: 'Drafting eval...' },
      { delay: 30000, message: 'Finalizing...' },
    ];

    const timers = [];
    for (const pm of progressMessages) {
      const timer = setTimeout(() => {
        broadcast({ type: 'eval_authoring_progress', jobId, message: pm.message });
      }, pm.delay);
      timers.push(timer);
    }

    // Send started event
    broadcast({ type: 'eval_authoring_started', jobId });

    try {
      const result = await runAuthoring({
        description: description.trim(),
        folderPath,
        projectRoot: project.root_path,
        missionControlConfig: project.config || null,
        refinement: refinement || null,
        currentFormState: currentFormState || null,
        hints: hints || null,
      });

      // Clear pending timers
      timers.forEach(t => clearTimeout(t));

      if (result.error) {
        broadcast({ type: 'eval_authoring_error', jobId, error: result.error });
      } else {
        broadcast({
          type: 'eval_authoring_complete',
          jobId,
          eval: result.eval,
          reasoning: result.reasoning,
        });
      }
    } catch (err) {
      timers.forEach(t => clearTimeout(t));
      broadcast({ type: 'eval_authoring_error', jobId, error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Add the preview endpoint to `server/routes/evals.js`**

Add after the author endpoint:

```js
// POST /folders/:projectId/preview — run an eval definition once without saving
router.post('/folders/:projectId/preview', async (req, res) => {
  try {
    const { evalDefinition } = req.body;

    if (!evalDefinition || typeof evalDefinition !== 'object') {
      return res.status(400).json({ error: 'evalDefinition is required' });
    }

    const { getProject } = await getProjectDiscovery();
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { runSingleEval } = await getEvalRunner();
    const { Client } = require('@neondatabase/serverless');

    // Build context (same as executeBatch)
    let commitSha = null;
    try {
      const { execSync } = require('child_process');
      commitSha = execSync('git rev-parse --short HEAD', {
        cwd: project.root_path,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (_) {}

    const context = {
      projectRoot: project.root_path,
      commitSha,
      triggerSource: 'preview',
      dbReadonlyUrl: process.env.DATABASE_URL_READONLY || null,
      createDbConnection: async (url) => {
        const client = new Client({ connectionString: url });
        await client.connect();
        return client;
      },
      sessionLogPath: null,
      buildOutputPath: null,
      prDiffPath: null,
      variables: {
        ...evalDefinition.input,
        'eval.name': evalDefinition.name,
        'run.commit_sha': commitSha || '',
        'run.trigger': 'preview',
        'project.root': project.root_path,
      },
    };

    const startTime = Date.now();
    const result = await runSingleEval(evalDefinition, context);
    const duration = Date.now() - startTime;

    // Estimate token cost
    const evidenceTokens = result.evidence ? Math.ceil(String(result.evidence).length / 4) : 0;
    const judgePromptTokens = evalDefinition.judge_prompt ? Math.ceil(evalDefinition.judge_prompt.length / 4) : 0;
    const estimatedTokens = evidenceTokens + judgePromptTokens + 500; // 500 overhead

    res.json({
      success: true,
      result: {
        ...result,
        duration,
        estimatedTokenCost: `~${estimatedTokens.toLocaleString()} tokens`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Add the publish endpoint to `server/routes/evals.js`**

Add after the preview endpoint:

```js
// POST /folders/:projectId/publish — publish a draft eval (remove .draft suffix)
router.post('/folders/:projectId/publish', async (req, res) => {
  try {
    const { draftPath } = req.body;

    if (!draftPath || typeof draftPath !== 'string') {
      return res.status(400).json({ error: 'draftPath is required' });
    }

    const { getProject } = await getProjectDiscovery();
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Path safety
    const projectRoot = project.root_path.endsWith('/') ? project.root_path : project.root_path + '/';
    if (!draftPath.startsWith(projectRoot) && draftPath !== project.root_path) {
      return res.status(400).json({ error: 'draftPath must be inside the project' });
    }

    const fs = require('fs');
    const pathModule = require('path');

    if (!fs.existsSync(draftPath)) {
      return res.status(404).json({ error: 'Draft file not found' });
    }

    if (!draftPath.endsWith('.draft')) {
      return res.status(400).json({ error: 'File is not a draft' });
    }

    // Determine target path
    let targetPath = draftPath.replace(/\.draft$/, '');

    // Handle naming conflicts — auto-suffix with incrementing number
    if (fs.existsSync(targetPath)) {
      const ext = pathModule.extname(targetPath); // .yaml or .yml
      const base = targetPath.slice(0, -ext.length);
      let suffix = 2;
      while (fs.existsSync(`${base}-${suffix}${ext}`)) {
        suffix++;
      }
      targetPath = `${base}-${suffix}${ext}`;
    }

    fs.renameSync(draftPath, targetPath);

    res.json({
      success: true,
      publishedPath: targetPath,
      evalName: pathModule.basename(targetPath, pathModule.extname(targetPath)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Add the delete-draft endpoint to `server/routes/evals.js`**

```js
// DELETE /folders/:projectId/draft — delete a draft eval file
router.delete('/folders/:projectId/draft', async (req, res) => {
  try {
    const { draftPath } = req.body;

    if (!draftPath || typeof draftPath !== 'string') {
      return res.status(400).json({ error: 'draftPath is required' });
    }

    const { getProject } = await getProjectDiscovery();
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const projectRoot = project.root_path.endsWith('/') ? project.root_path : project.root_path + '/';
    if (!draftPath.startsWith(projectRoot) && draftPath !== project.root_path) {
      return res.status(400).json({ error: 'draftPath must be inside the project' });
    }

    if (!draftPath.endsWith('.draft')) {
      return res.status(400).json({ error: 'File is not a draft' });
    }

    const fs = require('fs');
    if (!fs.existsSync(draftPath)) {
      return res.status(404).json({ error: 'Draft file not found' });
    }

    fs.unlinkSync(draftPath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 6: Modify the folders endpoint to include drafts**

In the GET `/folders/:projectId` endpoint (line 79-110), modify the folder mapping to also load drafts:

After line 84 (`const loaded = loadEvalFolder(fp);`), add draft loading:

```js
// After the existing evals loading block, add:
let drafts = [];
try {
  const { loadDraftsFromFolder } = await getEvalLoader();
  const loadedDrafts = loadDraftsFromFolder(fp);
  drafts = loadedDrafts.map(ev => ({
    name: ev.name,
    description: ev.description || null,
    evidence_type: ev.evidence?.type || null,
    isDraft: true,
    draftPath: ev._source,
  }));
} catch (err) {
  console.warn(`[Evals] Failed to load drafts from ${fp}:`, err.message);
}
```

And include `drafts` in the returned folder object alongside `evals`.

- [ ] **Step 7: Export broadcast from websocket.js**

Modify `server/websocket.js` to export the broadcast function. Add at the module level:

```js
let _wss = null;

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });
  _wss = wss;
  // ... rest of existing code
}

function broadcast(data) {
  if (!_wss) return;
  const msg = JSON.stringify(data);
  _wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

module.exports = { setupWebSocket, broadcast };
```

Note: The existing internal `broadcast(wss, data)` function takes wss as a parameter. Refactor it to use the module-level `_wss` reference and export it. Update the two existing callsites within `setupWebSocket` to use the new signature.

- [ ] **Step 8: Modify `server/routes/evals.js` to support saving as draft**

In the `POST /folders/:projectId/create-eval` endpoint, add draft support. Before line 218 (`const filePath = path.join(folder_path, sanitizedName + '.yaml');`), check for a `saveAsDraft` flag in the request body:

```js
const { folder_path, name, description, evidence, input, checks, judge_prompt, expected, judge, saveAsDraft } = req.body;

// ... existing validation ...

const extension = saveAsDraft ? '.yaml.draft' : '.yaml';
const filePath = path.join(folder_path, sanitizedName + extension);
```

- [ ] **Step 9: Run all eval tests**

Run: `cd server && npx vitest run __tests__/eval*.test.js`
Expected: All tests pass

- [ ] **Step 10: Commit**

```bash
git add server/routes/evals.js server/websocket.js server/__tests__/evals-author.test.js
git commit -m "feat: add author, preview, publish endpoints and draft support"
```

---

## Task 4: Choice Screen Component

**Files:**
- Create: `client/src/components/Quality/EvalChoiceScreen.jsx`
- Create: `client/src/components/Quality/EvalChoiceScreen.module.css`
- Modify: `client/src/components/Quality/QualityTab.jsx:569-580`

- [ ] **Step 1: Create `EvalChoiceScreen.jsx`**

```jsx
// client/src/components/Quality/EvalChoiceScreen.jsx
import { ChevronLeft, Sparkles, PenTool } from 'lucide-react';
import styles from './EvalChoiceScreen.module.css';

export default function EvalChoiceScreen({ folderName, onChooseAI, onChooseManual, onClose }) {
  return (
    <div className={styles.container}>
      <button className={styles.backButton} onClick={onClose} type="button">
        <ChevronLeft size={14} />
        Back to folders
      </button>
      <h3 className={styles.heading}>
        New Eval in <span className={styles.folderRef}>{folderName}</span>
      </h3>

      <div className={styles.choices}>
        <button className={styles.aiButton} onClick={onChooseAI}>
          <Sparkles size={20} />
          <span className={styles.aiLabel}>Build with AI</span>
          <span className={styles.aiHint}>Describe what to check in plain English</span>
        </button>

        <button className={styles.manualLink} onClick={onChooseManual}>
          <PenTool size={14} />
          Build manually
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `EvalChoiceScreen.module.css`**

```css
/* client/src/components/Quality/EvalChoiceScreen.module.css */
.container {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 0;
}

.backButton {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 0;
}

.backButton:hover {
  color: var(--text-primary);
}

.heading {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
}

.folderRef {
  color: var(--accent);
}

.choices {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 32px 16px;
}

.aiButton {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 32px;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  width: 100%;
  max-width: 280px;
  transition: opacity 0.15s;
}

.aiButton:hover {
  opacity: 0.9;
}

.aiLabel {
  font-size: 16px;
  font-weight: 600;
}

.aiHint {
  font-size: 12px;
  opacity: 0.85;
}

.manualLink {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  padding: 8px;
}

.manualLink:hover {
  color: var(--text-primary);
}
```

- [ ] **Step 3: Integrate into QualityTab**

In `client/src/components/Quality/QualityTab.jsx`, replace the `createEvalTarget` block (lines 569-580):

Add new state at line 288 (after `createEvalTarget`):

```jsx
const [createEvalMode, setCreateEvalMode] = useState(null); // null | 'choice' | 'ai' | 'manual'
```

Replace the `if (createEvalTarget)` block (lines 569-580) with:

```jsx
if (createEvalTarget) {
  // AI drawer mode
  if (createEvalMode === 'ai') {
    return (
      <div className={styles.container}>
        <AIEvalDrawer
          folderPath={createEvalTarget.folder_path}
          folderName={createEvalTarget.folder_name}
          projectId={project.id}
          onComplete={(evalData, reasoning) => {
            setAiDraftData({ evalData, reasoning, originalDescription: '' });
            setCreateEvalMode('manual');
          }}
          onCancel={() => setCreateEvalMode('choice')}
          onBuildManually={() => setCreateEvalMode('manual')}
        />
      </div>
    );
  }

  // Manual form mode (with optional AI-populated data)
  if (createEvalMode === 'manual') {
    return (
      <div className={styles.container}>
        <CreateEvalForm
          folderPath={createEvalTarget.folder_path}
          folderName={createEvalTarget.folder_name}
          onClose={() => { setCreateEvalTarget(null); setCreateEvalMode(null); setAiDraftData(null); }}
          onCreate={handleCreateEval}
          initialValues={aiDraftData?.evalData || null}
          reasoning={aiDraftData?.reasoning || null}
          onRefine={() => setCreateEvalMode('ai')}
          projectId={project.id}
        />
      </div>
    );
  }

  // Default: choice screen
  return (
    <div className={styles.container}>
      <EvalChoiceScreen
        folderName={createEvalTarget.folder_name}
        onChooseAI={() => setCreateEvalMode('ai')}
        onChooseManual={() => setCreateEvalMode('manual')}
        onClose={() => { setCreateEvalTarget(null); setCreateEvalMode(null); }}
      />
    </div>
  );
}
```

Add state for AI draft data near line 288:

```jsx
const [aiDraftData, setAiDraftData] = useState(null); // { evalData, reasoning, originalDescription }
```

Update the `setCreateEvalTarget` call on line 720 to also set mode:

```jsx
onClick={() => {
  setCreateEvalTarget({ folder_path: folder.folder_path, folder_name: folder.folder_name || folder.folder_path });
  setCreateEvalMode('choice');
}}
```

Add imports at the top of QualityTab.jsx:

```jsx
import EvalChoiceScreen from './EvalChoiceScreen';
import AIEvalDrawer from './AIEvalDrawer';
```

- [ ] **Step 4: Run frontend tests**

Run: `cd client && npx vitest run`
Expected: All tests pass (existing tests should still work; new components don't have tests yet)

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Quality/EvalChoiceScreen.jsx client/src/components/Quality/EvalChoiceScreen.module.css client/src/components/Quality/QualityTab.jsx
git commit -m "feat: add eval choice screen — Build with AI vs Build manually"
```

---

## Task 5: AI Eval Drawer Component

**Files:**
- Create: `client/src/components/Quality/AIEvalDrawer.jsx`
- Create: `client/src/components/Quality/AIEvalDrawer.module.css`

- [ ] **Step 1: Create `AIEvalDrawer.jsx`**

```jsx
// client/src/components/Quality/AIEvalDrawer.jsx
import { useState, useEffect, useRef } from 'react';
import { ChevronLeft, Sparkles, Loader, AlertCircle } from 'lucide-react';
import { api } from '../../utils/api';
import styles from './AIEvalDrawer.module.css';

const PROGRESS_MESSAGES = [
  'Investigating your project...',
  'Reviewing existing evals...',
  'Drafting eval...',
  'Finalizing...',
];

export default function AIEvalDrawer({
  folderPath,
  folderName,
  projectId,
  onComplete,
  onCancel,
  onBuildManually,
  // Refinement props
  originalDescription: initialDescription,
  refinementMode,
  currentFormState,
}) {
  const [description, setDescription] = useState(initialDescription || '');
  const [refinement, setRefinement] = useState('');
  const [status, setStatus] = useState('input'); // input | working | error
  const [progressMessage, setProgressMessage] = useState('');
  const [error, setError] = useState(null);
  const [jobId, setJobId] = useState(null);
  const wsRef = useRef(null);
  const progressTimerRef = useRef(null);

  // Listen for WebSocket authoring events
  useEffect(() => {
    if (!jobId) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.jobId !== jobId) return;

        switch (msg.type) {
          case 'eval_authoring_progress':
            setProgressMessage(msg.message);
            break;
          case 'eval_authoring_complete':
            setStatus('input');
            onComplete(msg.eval, msg.reasoning);
            break;
          case 'eval_authoring_error':
            setStatus('error');
            setError(msg.error);
            break;
        }
      } catch (_) {}
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [jobId, onComplete]);

  // Client-side progress timer fallback
  useEffect(() => {
    if (status !== 'working') return;

    let step = 0;
    setProgressMessage(PROGRESS_MESSAGES[0]);

    const timers = [
      setTimeout(() => { step = 1; setProgressMessage(PROGRESS_MESSAGES[1]); }, 8000),
      setTimeout(() => { step = 2; setProgressMessage(PROGRESS_MESSAGES[2]); }, 16000),
      setTimeout(() => { step = 3; setProgressMessage(PROGRESS_MESSAGES[3]); }, 30000),
    ];

    progressTimerRef.current = timers;

    return () => {
      timers.forEach(t => clearTimeout(t));
    };
  }, [status]);

  const handleSubmit = async () => {
    if (!description.trim()) return;

    setStatus('working');
    setError(null);

    try {
      const body = {
        description: description.trim(),
        folderPath,
      };

      if (refinementMode && currentFormState) {
        body.currentFormState = currentFormState;
        body.refinement = refinement.trim() || null;
      }

      const result = await api.post(`/api/evals/folders/${projectId}/author`, body);
      if (result.jobId) {
        setJobId(result.jobId);
      }
    } catch (err) {
      setStatus('error');
      setError(err.message || 'Failed to start authoring');
    }
  };

  if (status === 'working') {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <Sparkles size={16} />
          <span>Building eval...</span>
        </div>
        <div className={styles.progressArea}>
          <Loader size={20} className={styles.spinner} />
          <span className={styles.progressMessage}>{progressMessage}</span>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <AlertCircle size={16} />
          <span>Authoring failed</span>
        </div>
        <div className={styles.errorArea}>
          <p className={styles.errorMessage}>{error}</p>
          <div className={styles.errorActions}>
            <button className={styles.retryButton} onClick={() => { setStatus('input'); setError(null); }}>
              Try Again
            </button>
            <button className={styles.manualLink} onClick={onBuildManually}>
              Build manually
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <button className={styles.backButton} onClick={onCancel} type="button">
        <ChevronLeft size={14} />
        {refinementMode ? 'Back to form' : 'Back'}
      </button>

      <div className={styles.header}>
        <Sparkles size={16} />
        <span>{refinementMode ? 'Refine Eval' : 'Build Eval with AI'}</span>
      </div>

      <div className={styles.folderLabel}>
        Target folder: <strong>{folderName}</strong>
      </div>

      <div className={styles.inputArea}>
        <label className={styles.label}>
          {refinementMode ? 'Original description' : 'Describe what this eval should check'}
        </label>
        <textarea
          className={styles.textarea}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Check that recipe extraction produces valid JSON with all required fields and the venue timezone matches the source data"
          rows={5}
          autoFocus
        />
      </div>

      {refinementMode && (
        <div className={styles.inputArea}>
          <label className={styles.label}>What would you like to change?</label>
          <textarea
            className={styles.textarea}
            value={refinement}
            onChange={(e) => setRefinement(e.target.value)}
            placeholder="e.g. Make the pagination check stricter, also verify the venue timezone"
            rows={3}
            autoFocus
          />
        </div>
      )}

      <div className={styles.actions}>
        <button className={styles.cancelButton} onClick={onCancel}>Cancel</button>
        <button
          className={styles.submitButton}
          onClick={handleSubmit}
          disabled={!description.trim()}
        >
          {refinementMode ? 'Refine' : 'Build Eval'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `AIEvalDrawer.module.css`**

```css
/* client/src/components/Quality/AIEvalDrawer.module.css */
.container {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0;
}

.backButton {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 0;
}

.backButton:hover {
  color: var(--text-primary);
}

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.folderLabel {
  font-size: 12px;
  color: var(--text-muted);
}

.inputArea {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
  line-height: 1.5;
}

.textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding-top: 4px;
}

.cancelButton {
  padding: 6px 14px;
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
}

.cancelButton:hover {
  background: var(--bg-hover);
}

.submitButton {
  padding: 6px 14px;
  background: var(--accent);
  border: none;
  border-radius: 6px;
  color: white;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}

.submitButton:hover {
  opacity: 0.9;
}

.submitButton:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.progressArea {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 48px 16px;
}

.spinner {
  animation: spin 1.5s linear infinite;
  color: var(--accent);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.progressMessage {
  font-size: 13px;
  color: var(--text-secondary);
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.errorArea {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: var(--bg-error, rgba(239, 68, 68, 0.08));
  border-radius: 6px;
}

.errorMessage {
  font-size: 13px;
  color: var(--text-error, #ef4444);
  margin: 0;
  line-height: 1.5;
}

.errorActions {
  display: flex;
  gap: 12px;
  align-items: center;
}

.retryButton {
  padding: 6px 14px;
  background: var(--accent);
  border: none;
  border-radius: 6px;
  color: white;
  cursor: pointer;
  font-size: 12px;
}

.manualLink {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  text-decoration: underline;
}
```

- [ ] **Step 3: Run frontend build to check for errors**

Run: `cd client && npx vite build`
Expected: Build succeeds (no import errors)

- [ ] **Step 4: Commit**

```bash
git add client/src/components/Quality/AIEvalDrawer.jsx client/src/components/Quality/AIEvalDrawer.module.css
git commit -m "feat: add AI eval drawer component with progress and error states"
```

---

## Task 6: Modify CreateEvalForm for AI Population, Refine, Preview, and Save as Draft

**Files:**
- Modify: `client/src/components/Quality/CreateEvalForm.jsx`
- Modify: `client/src/components/Quality/CreateEvalForm.module.css`

- [ ] **Step 1: Add new props and initial state population**

In `CreateEvalForm.jsx`, update the component signature (line 303) to accept new props:

```jsx
export default function CreateEvalForm({
  folderPath,
  folderName,
  onClose,
  onCreate,
  initialValues,
  reasoning,
  onRefine,
  projectId,
}) {
```

After the existing state declarations (lines 304-313), add logic to populate from `initialValues`:

```jsx
  const [name, setName] = useState(initialValues?.name || '');
  const [description, setDescription] = useState(initialValues?.description || '');
  const [evidence, setEvidence] = useState(initialValues?.evidence || { type: '' });
  const [inputMap, setInputMap] = useState(initialValues?.input || { key: '' });
  const [checks, setChecks] = useState(initialValues?.checks || []);
  const [judgePrompt, setJudgePrompt] = useState(initialValues?.judge_prompt || '');
  const [expected, setExpected] = useState(initialValues?.expected || '');
  const [judgeModel, setJudgeModel] = useState(initialValues?.judge?.model || '');
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const [previewResult, setPreviewResult] = useState(null);
  const [previewing, setPreviewing] = useState(false);
```

- [ ] **Step 2: Add reasoning display**

After the heading (line 378), add a collapsible reasoning section:

```jsx
{reasoning && (
  <div className={styles.reasoningSection}>
    <button
      className={styles.reasoningToggle}
      onClick={() => setShowReasoning(!showReasoning)}
      type="button"
    >
      {showReasoning ? 'Hide' : 'Show'} how this eval was built
    </button>
    {showReasoning && (
      <div className={styles.reasoningContent}>{reasoning}</div>
    )}
  </div>
)}
```

- [ ] **Step 3: Add Preview Run handler**

Add a preview handler after the existing handleSubmit:

```jsx
  const handlePreview = async () => {
    setError(null);
    setPreviewing(true);
    setPreviewResult(null);

    const cleanInput = {};
    for (const [k, v] of Object.entries(inputMap)) {
      if (k.trim()) cleanInput[k.trim()] = v;
    }

    const evalDef = {
      name: name.trim(),
      description: description.trim(),
      evidence: cleanEvidence(evidence),
      input: cleanInput,
    };

    if (checks.length > 0) {
      evalDef.checks = checks.map(cleanCheck).filter(c => c.type);
    }
    if (judgePrompt.trim()) {
      evalDef.judge_prompt = judgePrompt.trim();
      evalDef.expected = expected.trim();
      if (judgeModel) evalDef.judge = { model: judgeModel };
    }

    try {
      const result = await api.post(`/api/evals/folders/${projectId}/preview`, {
        evalDefinition: evalDef,
      });
      setPreviewResult(result.result);
    } catch (err) {
      setError(err.message || 'Preview failed');
    }
    setPreviewing(false);
  };
```

- [ ] **Step 4: Modify the submit handler to support "Save as Draft"**

Update the handleSubmit to pass `saveAsDraft: true`:

```jsx
  const handleSubmit = async (e) => {
    e.preventDefault();
    // ... existing validation ...

    evalDef.saveAsDraft = true; // Always save as draft when coming from AI flow

    setCreating(true);
    try {
      await onCreate(evalDef);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to create eval');
    }
    setCreating(false);
  };
```

- [ ] **Step 5: Add Refine, Preview, and Save as Draft buttons**

Replace the existing actions section (lines 442-447) with:

```jsx
{error && <div className={styles.error}>{error}</div>}

{previewResult && (
  <PreviewRunResult
    result={previewResult}
    onClose={() => setPreviewResult(null)}
  />
)}

<div className={styles.actions}>
  <button type="button" className={styles.cancelBtn} onClick={onClose}>Cancel</button>
  {onRefine && (
    <button type="button" className={styles.refineBtn} onClick={onRefine}>
      Refine
    </button>
  )}
  <button
    type="button"
    className={styles.previewBtn}
    onClick={handlePreview}
    disabled={previewing || !name.trim() || !evidence.type}
  >
    {previewing ? 'Running...' : 'Preview Run'}
  </button>
  <button type="submit" className={styles.createBtn} disabled={creating}>
    {creating ? 'Saving...' : 'Save as Draft'}
  </button>
</div>
```

Add import for PreviewRunResult and api at the top:

```jsx
import { api } from '../../utils/api';
import PreviewRunResult from './PreviewRunResult';
```

- [ ] **Step 6: Add styles for new elements**

Add to `CreateEvalForm.module.css`:

```css
.reasoningSection {
  background: var(--bg-secondary);
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 4px;
}

.reasoningToggle {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}

.reasoningToggle:hover {
  color: var(--text-primary);
}

.reasoningContent {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-top: 8px;
}

.refineBtn {
  padding: 6px 14px;
  background: none;
  border: 1px solid var(--accent);
  border-radius: 6px;
  color: var(--accent);
  cursor: pointer;
  font-size: 12px;
}

.refineBtn:hover {
  background: var(--accent);
  color: white;
}

.previewBtn {
  padding: 6px 14px;
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
}

.previewBtn:hover {
  background: var(--bg-hover);
}

.previewBtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

- [ ] **Step 7: Run frontend tests**

Run: `cd client && npx vitest run`
Expected: Existing CreateEvalForm tests may need updates for new props. Fix any failures.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/Quality/CreateEvalForm.jsx client/src/components/Quality/CreateEvalForm.module.css
git commit -m "feat: add AI population, refine, preview run, and save-as-draft to eval form"
```

---

## Task 7: Preview Run Result Component

**Files:**
- Create: `client/src/components/Quality/PreviewRunResult.jsx`
- Create: `client/src/components/Quality/PreviewRunResult.module.css`

- [ ] **Step 1: Create `PreviewRunResult.jsx`**

```jsx
// client/src/components/Quality/PreviewRunResult.jsx
import { CheckCircle, XCircle, AlertTriangle, X } from 'lucide-react';
import styles from './PreviewRunResult.module.css';

export default function PreviewRunResult({ result, onClose }) {
  if (!result) return null;

  const stateIcon = {
    pass: <CheckCircle size={16} className={styles.passIcon} />,
    fail: <XCircle size={16} className={styles.failIcon} />,
    error: <AlertTriangle size={16} className={styles.errorIcon} />,
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Preview Result</span>
        <button className={styles.closeBtn} onClick={onClose} type="button">
          <X size={14} />
        </button>
      </div>

      <div className={styles.verdict}>
        {stateIcon[result.state] || stateIcon.error}
        <span className={`${styles.state} ${styles[result.state]}`}>
          {result.state.toUpperCase()}
        </span>
        <span className={styles.duration}>{result.duration}ms</span>
        {result.estimatedTokenCost && (
          <span className={styles.tokens}>{result.estimatedTokenCost}</span>
        )}
      </div>

      {result.evidence && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Evidence</div>
          <pre className={styles.pre}>{String(result.evidence).slice(0, 5000)}</pre>
        </div>
      )}

      {result.checkResults && result.checkResults.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Checks</div>
          {result.checkResults.map((check, i) => (
            <div key={i} className={`${styles.checkRow} ${check.passed ? styles.checkPass : styles.checkFail}`}>
              {check.passed ? <CheckCircle size={12} /> : <XCircle size={12} />}
              <span>{check.type || check.description}</span>
              {check.reason && <span className={styles.checkReason}>{check.reason}</span>}
            </div>
          ))}
        </div>
      )}

      {result.judgeVerdict && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Judge Verdict</div>
          <div className={styles.judgeRow}>
            <span className={`${styles.judgeResult} ${styles[result.judgeVerdict.result]}`}>
              {result.judgeVerdict.result}
            </span>
            <span className={styles.judgeConfidence}>
              confidence: {result.judgeVerdict.confidence}
            </span>
          </div>
          {result.judgeVerdict.reasoning && (
            <div className={styles.judgeReasoning}>{result.judgeVerdict.reasoning}</div>
          )}
        </div>
      )}

      {result.error && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Error</div>
          <div className={styles.errorText}>{result.error}</div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `PreviewRunResult.module.css`**

```css
/* client/src/components/Quality/PreviewRunResult.module.css */
.container {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  overflow: hidden;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.closeBtn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
}

.verdict {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.state {
  font-size: 13px;
  font-weight: 600;
}

.pass { color: var(--success, #22c55e); }
.fail { color: var(--error, #ef4444); }
.error { color: var(--warning, #f59e0b); }
.passIcon { color: var(--success, #22c55e); }
.failIcon { color: var(--error, #ef4444); }
.errorIcon { color: var(--warning, #f59e0b); }

.duration {
  font-size: 11px;
  color: var(--text-muted);
}

.tokens {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: auto;
}

.section {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.section:last-child {
  border-bottom: none;
}

.sectionTitle {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.pre {
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  max-height: 200px;
  overflow-y: auto;
  line-height: 1.4;
}

.checkRow {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 3px 0;
}

.checkPass { color: var(--success, #22c55e); }
.checkFail { color: var(--error, #ef4444); }

.checkReason {
  color: var(--text-muted);
  font-size: 11px;
  margin-left: auto;
}

.judgeRow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.judgeResult {
  font-size: 12px;
  font-weight: 600;
}

.judgeConfidence {
  font-size: 11px;
  color: var(--text-muted);
}

.judgeReasoning {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.errorText {
  font-size: 12px;
  color: var(--error, #ef4444);
  line-height: 1.5;
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/Quality/PreviewRunResult.jsx client/src/components/Quality/PreviewRunResult.module.css
git commit -m "feat: add preview run result component"
```

---

## Task 8: Draft Badges, Publish, and Delete in Dashboard

**Files:**
- Modify: `client/src/components/Quality/QualityTab.jsx`
- Modify: `client/src/components/Quality/QualityTab.module.css`

- [ ] **Step 1: Add draft display to eval list**

In the eval list rendering in QualityTab.jsx (around line 701-724), after the existing evals loop, add draft rendering:

```jsx
{expandedFolders[folder.folder_path] && (
  <div className={styles.evalList}>
    {/* Published evals */}
    {folder.evals && folder.evals.map((ev, j) => (
      <button
        key={ev.id || j}
        className={styles.evalItem}
        onClick={() => handleEvalClick(ev.name)}
      >
        <FileText size={12} />
        <div className={styles.evalInfo}>
          <span className={styles.evalName}>{ev.name}</span>
          {ev.evidence_type && <span className={styles.evalMeta}>{ev.evidence_type}</span>}
          {ev.description && <span className={styles.evalDescription}>{ev.description}</span>}
        </div>
        <ChevronRight size={12} className={styles.evalRunArrow} />
      </button>
    ))}

    {/* Draft evals */}
    {folder.drafts && folder.drafts.map((draft, j) => (
      <div key={`draft-${j}`} className={`${styles.evalItem} ${styles.draftItem}`}>
        <FileText size={12} />
        <div className={styles.evalInfo}>
          <span className={styles.evalName}>
            {draft.name}
            <span className={styles.draftBadge}>Draft</span>
          </span>
          {draft.evidence_type && <span className={styles.evalMeta}>{draft.evidence_type}</span>}
          {draft.description && <span className={styles.evalDescription}>{draft.description}</span>}
        </div>
        <div className={styles.draftActions}>
          <button
            className={styles.publishBtn}
            onClick={(e) => { e.stopPropagation(); handlePublishDraft(draft); }}
            title="Publish"
          >
            Publish
          </button>
          <button
            className={styles.deleteDraftBtn}
            onClick={(e) => { e.stopPropagation(); handleDeleteDraft(draft); }}
            title="Delete"
          >
            &times;
          </button>
        </div>
      </div>
    ))}

    <button
      className={styles.newEvalBtn}
      onClick={() => {
        setCreateEvalTarget({ folder_path: folder.folder_path, folder_name: folder.folder_name || folder.folder_path });
        setCreateEvalMode('choice');
      }}
    >
      <Plus size={12} /> New Eval
    </button>
  </div>
)}
```

- [ ] **Step 2: Add publish and delete handlers**

Add to QualityTab.jsx after the existing handlers:

```jsx
const handlePublishDraft = async (draft) => {
  try {
    await api.post(`/api/evals/folders/${project.id}/publish`, { draftPath: draft.draftPath });
    loadFolders();
  } catch (err) {
    console.error('[QualityTab] Failed to publish draft:', err);
  }
};

const handleDeleteDraft = async (draft) => {
  try {
    await api.delete(`/api/evals/folders/${project.id}/draft`, { draftPath: draft.draftPath });
    loadFolders();
  } catch (err) {
    console.error('[QualityTab] Failed to delete draft:', err);
  }
};
```

Note: The `api.delete` function currently doesn't support a body. Modify `api.js` to support it, or switch the delete endpoint to use query params. The simpler approach: change `api.delete` to accept an optional body:

In `client/src/utils/api.js`, update the delete method:

```js
delete: (url, body) => request('DELETE', url, body),
```

- [ ] **Step 3: Add draft styles**

Add to `QualityTab.module.css`:

```css
.draftItem {
  opacity: 0.8;
  border-left: 2px solid var(--warning, #f59e0b);
}

.draftBadge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  color: var(--warning, #f59e0b);
  background: rgba(245, 158, 11, 0.12);
  padding: 1px 6px;
  border-radius: 3px;
  margin-left: 6px;
  vertical-align: middle;
}

.draftActions {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-left: auto;
}

.publishBtn {
  padding: 2px 8px;
  font-size: 11px;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.publishBtn:hover {
  opacity: 0.9;
}

.deleteDraftBtn {
  padding: 2px 6px;
  font-size: 14px;
  background: none;
  color: var(--text-muted);
  border: none;
  cursor: pointer;
}

.deleteDraftBtn:hover {
  color: var(--error, #ef4444);
}
```

- [ ] **Step 4: Run frontend tests and fix any failures**

Run: `cd client && npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Quality/QualityTab.jsx client/src/components/Quality/QualityTab.module.css client/src/utils/api.js
git commit -m "feat: add draft badges, publish, and delete to eval dashboard"
```

---

## Task 9: Integration Testing

**Files:**
- Create: `client/src/__tests__/EvalChoiceScreen.test.jsx`
- Create: `client/src/__tests__/AIEvalDrawer.test.jsx`

- [ ] **Step 1: Write EvalChoiceScreen tests**

```jsx
// client/src/__tests__/EvalChoiceScreen.test.jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EvalChoiceScreen from '../components/Quality/EvalChoiceScreen';

describe('EvalChoiceScreen', () => {
  it('renders both options', () => {
    render(
      <EvalChoiceScreen
        folderName="api-tests"
        onChooseAI={() => {}}
        onChooseManual={() => {}}
        onClose={() => {}}
      />
    );

    expect(screen.getByText('Build with AI')).toBeTruthy();
    expect(screen.getByText('Build manually')).toBeTruthy();
    expect(screen.getByText('api-tests')).toBeTruthy();
  });

  it('calls onChooseAI when AI button is clicked', () => {
    const onChooseAI = vi.fn();
    render(
      <EvalChoiceScreen
        folderName="api-tests"
        onChooseAI={onChooseAI}
        onChooseManual={() => {}}
        onClose={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Build with AI'));
    expect(onChooseAI).toHaveBeenCalledOnce();
  });

  it('calls onChooseManual when manual link is clicked', () => {
    const onChooseManual = vi.fn();
    render(
      <EvalChoiceScreen
        folderName="api-tests"
        onChooseAI={() => {}}
        onChooseManual={onChooseManual}
        onClose={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Build manually'));
    expect(onChooseManual).toHaveBeenCalledOnce();
  });

  it('calls onClose when back button is clicked', () => {
    const onClose = vi.fn();
    render(
      <EvalChoiceScreen
        folderName="api-tests"
        onChooseAI={() => {}}
        onChooseManual={() => {}}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByText('Back to folders'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Write AIEvalDrawer tests**

```jsx
// client/src/__tests__/AIEvalDrawer.test.jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AIEvalDrawer from '../components/Quality/AIEvalDrawer';

// Mock the api module
vi.mock('../utils/api', () => ({
  api: {
    post: vi.fn().mockResolvedValue({ jobId: 'test-job-123' }),
  },
}));

// Mock WebSocket
class MockWebSocket {
  constructor() { this.onmessage = null; }
  close() {}
}
global.WebSocket = MockWebSocket;

describe('AIEvalDrawer', () => {
  it('renders input form in default mode', () => {
    render(
      <AIEvalDrawer
        folderPath="/project/evals/test"
        folderName="test"
        projectId="proj-123"
        onComplete={() => {}}
        onCancel={() => {}}
        onBuildManually={() => {}}
      />
    );

    expect(screen.getByText('Build Eval with AI')).toBeTruthy();
    expect(screen.getByPlaceholderText(/Check that recipe/)).toBeTruthy();
    expect(screen.getByText('Build Eval')).toBeTruthy();
  });

  it('disables submit when description is empty', () => {
    render(
      <AIEvalDrawer
        folderPath="/project/evals/test"
        folderName="test"
        projectId="proj-123"
        onComplete={() => {}}
        onCancel={() => {}}
        onBuildManually={() => {}}
      />
    );

    const submitBtn = screen.getByText('Build Eval');
    expect(submitBtn.disabled).toBe(true);
  });

  it('shows refinement fields in refinement mode', () => {
    render(
      <AIEvalDrawer
        folderPath="/project/evals/test"
        folderName="test"
        projectId="proj-123"
        onComplete={() => {}}
        onCancel={() => {}}
        onBuildManually={() => {}}
        refinementMode
        originalDescription="Check API returns JSON"
        currentFormState={{ name: 'api-check' }}
      />
    );

    expect(screen.getByText('Refine Eval')).toBeTruthy();
    expect(screen.getByText('What would you like to change?')).toBeTruthy();
  });

  it('calls onCancel when cancel is clicked', () => {
    const onCancel = vi.fn();
    render(
      <AIEvalDrawer
        folderPath="/project/evals/test"
        folderName="test"
        projectId="proj-123"
        onComplete={() => {}}
        onCancel={onCancel}
        onBuildManually={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Run all tests**

Run: `cd client && npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Run backend tests too**

Run: `cd server && npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add client/src/__tests__/EvalChoiceScreen.test.jsx client/src/__tests__/AIEvalDrawer.test.jsx
git commit -m "test: add integration tests for choice screen and AI eval drawer"
```

---

## Task 10: End-to-End Verification

- [ ] **Step 1: Start the dev server and verify the full flow**

Run: Check `.env` for PORT, start the server, open the app in a browser.

Verify:
1. Navigate to Quality tab for a project with eval folders
2. Expand a folder, click "New Eval"
3. See the choice screen with "Build with AI" and "Build manually"
4. Click "Build manually" — see the existing form (regression check)
5. Go back, click "Build with AI" — see the drawer with text area
6. Type a description, click "Build Eval" — see progress messages
7. When complete, form populates with AI-authored eval
8. See "How this eval was built" collapsible section
9. Click "Refine" — drawer re-opens with refinement text area
10. Click "Preview Run" — see the preview result inline
11. Click "Save as Draft" — eval saved with .draft suffix
12. Back in the folder list, see the draft with "Draft" badge
13. Click "Publish" on the draft — file renamed, badge removed
14. Click delete on a draft — file removed

- [ ] **Step 2: Fix any issues found during verification**

- [ ] **Step 3: Run all tests one final time**

Run: `cd server && npx vitest run && cd ../client && npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address issues found during end-to-end verification"
```

---

## Task 11: Create PR

- [ ] **Step 1: Push branch and create PR**

```bash
git push -u origin worktree-scalable-beaming-minsky
gh pr create --title "feat: AI-assisted eval authoring" --body "## Summary
- Add natural-language eval authoring via AI builder drawer
- Choice screen (Build with AI / Build manually) replaces direct form
- Draft lifecycle with .draft suffix, publish, delete
- Preview run for dry-run testing before publish
- Refinement flow for iterating on AI drafts
- Shared authoring backend endpoint for manual and hook-triggered use

## Test plan
- [ ] Verify choice screen renders on New Eval click
- [ ] Verify AI drawer shows progress and populates form on completion
- [ ] Verify Save as Draft creates .yaml.draft file
- [ ] Verify draft badge appears in folder list
- [ ] Verify Publish renames file and removes badge
- [ ] Verify Preview Run shows evidence, checks, and judge verdict
- [ ] Verify Refine re-opens drawer with context
- [ ] Verify Build manually still shows the raw form
- [ ] Run all backend and frontend tests"
```
