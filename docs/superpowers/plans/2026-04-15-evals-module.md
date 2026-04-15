# Evals Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an evaluation system to Mission Control with project-scoped quality rules, YAML-defined evals, LLM-as-judge, and a unified Quality tab in the session view.

**Architecture:** Projects get promoted from implicit directory groupings to first-class DB entities with `.mission-control.yaml` discovery. Evals are YAML files in the project repo, read from disk at runtime. An evidence-gathering → checks → judge pipeline produces structured verdicts. Results feed back to CLI sessions as prose messages.

**Tech Stack:** Node.js/Express backend, React frontend, Neon Postgres, js-yaml for YAML parsing, existing LLM Gateway for judge calls.

**Spec:** `docs/superpowers/specs/2026-04-15-evals-module-design.md`

---

## Phase 1: Foundation — Project Entity

### Task 1: Install js-yaml dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install js-yaml**

Run: `npm install js-yaml`

- [ ] **Step 2: Verify installation**

Run: `node -e "const yaml = require('js-yaml'); console.log(yaml.load('test: true'))"`
Expected: `{ test: true }`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add js-yaml dependency for eval YAML parsing"
```

---

### Task 2: Projects database table and migration

**Files:**
- Modify: `server/database.js`
- Create: `server/__tests__/projects-schema.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/projects-schema.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the neon database
const mockQuery = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: () => mockQuery,
}));

describe('Projects schema', () => {
  it('initializeDb creates projects table', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    
    // Import after mocking
    const { initializeDb } = await import('../database.js');
    await initializeDb();
    
    // Find the CREATE TABLE projects call
    const calls = mockQuery.mock.calls.map(c => c[0]);
    const projectsCreate = calls.find(sql => 
      typeof sql === 'string' && sql.includes('CREATE TABLE IF NOT EXISTS projects')
    );
    
    expect(projectsCreate).toBeDefined();
    expect(projectsCreate).toContain('id TEXT PRIMARY KEY');
    expect(projectsCreate).toContain('name TEXT NOT NULL');
    expect(projectsCreate).toContain('root_path TEXT NOT NULL UNIQUE');
    expect(projectsCreate).toContain('settings JSONB');
    expect(projectsCreate).toContain('created_at');
  });

  it('initializeDb adds project_id to sessions table', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    
    const { initializeDb } = await import('../database.js');
    await initializeDb();
    
    const calls = mockQuery.mock.calls.map(c => c[0]);
    const migration = calls.find(sql => 
      typeof sql === 'string' && sql.includes('ADD COLUMN') && sql.includes('project_id')
    );
    
    expect(migration).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/projects-schema.test.js`
Expected: FAIL — no projects table in initializeDb yet

- [ ] **Step 3: Add projects table to database.js**

In `server/database.js`, add to the statements array inside `initializeDb()`, after the existing CREATE TABLE statements:

```javascript
`CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT NOW(),
  settings JSONB DEFAULT '{}'::jsonb
)`,
```

Add to the migrations array:

```javascript
`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id)`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/__tests__/projects-schema.test.js`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add server/database.js server/__tests__/projects-schema.test.js
git commit -m "feat: add projects table and session project_id migration"
```

---

### Task 3: Project discovery service

**Files:**
- Create: `server/services/projectDiscovery.js`
- Create: `server/__tests__/projectDiscovery.test.js`

- [ ] **Step 1: Write failing tests for .mission-control.yaml discovery**

Create `server/__tests__/projectDiscovery.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

const mockQuery = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: () => mockQuery,
}));

const mockFs = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
};
vi.mock('fs', () => ({ default: mockFs, ...mockFs }));

describe('projectDiscovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('findProjectRoot', () => {
    it('finds .mission-control.yaml in the given directory', async () => {
      const { findProjectRoot } = await import('../services/projectDiscovery.js');
      
      mockFs.existsSync.mockImplementation((p) => 
        p === '/Users/me/projects/event-scraper/.mission-control.yaml'
      );
      
      const result = findProjectRoot('/Users/me/projects/event-scraper');
      expect(result).toBe('/Users/me/projects/event-scraper');
    });

    it('walks up directory tree to find .mission-control.yaml', async () => {
      const { findProjectRoot } = await import('../services/projectDiscovery.js');
      
      mockFs.existsSync.mockImplementation((p) => 
        p === '/Users/me/projects/event-scraper/.mission-control.yaml'
      );
      
      const result = findProjectRoot('/Users/me/projects/event-scraper/src/utils');
      expect(result).toBe('/Users/me/projects/event-scraper');
    });

    it('returns null if no .mission-control.yaml found', async () => {
      const { findProjectRoot } = await import('../services/projectDiscovery.js');
      
      mockFs.existsSync.mockReturnValue(false);
      
      const result = findProjectRoot('/Users/me/projects/event-scraper');
      expect(result).toBeNull();
    });
  });

  describe('loadProjectConfig', () => {
    it('parses .mission-control.yaml correctly', async () => {
      const { loadProjectConfig } = await import('../services/projectDiscovery.js');
      
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(`
project:
  name: event-scraper
evals:
  folders:
    - evals/event-onboarding
    - evals/recipe-extraction
quality_rules:
  enabled:
    - no-hardcoded-secrets
  disabled:
    - enforce-types
`);
      
      const config = loadProjectConfig('/Users/me/projects/event-scraper');
      expect(config.project.name).toBe('event-scraper');
      expect(config.evals.folders).toEqual(['evals/event-onboarding', 'evals/recipe-extraction']);
      expect(config.quality_rules.enabled).toEqual(['no-hardcoded-secrets']);
      expect(config.quality_rules.disabled).toEqual(['enforce-types']);
    });

    it('returns default config when file not found', async () => {
      const { loadProjectConfig } = await import('../services/projectDiscovery.js');
      
      mockFs.existsSync.mockReturnValue(false);
      
      const config = loadProjectConfig('/Users/me/projects/event-scraper');
      expect(config).toEqual({ project: {}, evals: { folders: [] }, quality_rules: { enabled: [], disabled: [] } });
    });
  });

  describe('resolveProject', () => {
    it('creates project record if none exists', async () => {
      const { resolveProject } = await import('../services/projectDiscovery.js');
      
      mockFs.existsSync.mockImplementation((p) => 
        p === '/Users/me/projects/event-scraper/.mission-control.yaml'
      );
      mockFs.readFileSync.mockReturnValue('project:\n  name: event-scraper\nevals:\n  folders: []\nquality_rules:\n  enabled: []\n  disabled: []');
      
      // No existing project
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Insert returns new project
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'proj-123', name: 'event-scraper', root_path: '/Users/me/projects/event-scraper' }] });
      
      const project = await resolveProject('/Users/me/projects/event-scraper');
      expect(project).toBeDefined();
      expect(project.name).toBe('event-scraper');
    });

    it('returns existing project if found by root_path', async () => {
      const { resolveProject } = await import('../services/projectDiscovery.js');
      
      mockFs.existsSync.mockImplementation((p) => 
        p === '/Users/me/projects/event-scraper/.mission-control.yaml'
      );
      mockFs.readFileSync.mockReturnValue('project:\n  name: event-scraper\nevals:\n  folders: []\nquality_rules:\n  enabled: []\n  disabled: []');
      
      // Existing project found
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'proj-123', name: 'event-scraper', root_path: '/Users/me/projects/event-scraper', settings: '{}' }] });
      
      const project = await resolveProject('/Users/me/projects/event-scraper');
      expect(project.id).toBe('proj-123');
    });

    it('returns null if no .mission-control.yaml found', async () => {
      const { resolveProject } = await import('../services/projectDiscovery.js');
      
      mockFs.existsSync.mockReturnValue(false);
      
      const project = await resolveProject('/Users/me/projects/event-scraper');
      expect(project).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/projectDiscovery.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement projectDiscovery.js**

Create `server/services/projectDiscovery.js`:

```javascript
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { query } = require('../database');
const { v4: uuidv4 } = require('uuid');

const CONFIG_FILENAME = '.mission-control.yaml';

function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, CONFIG_FILENAME))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  
  return null;
}

function loadProjectConfig(projectRoot) {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  
  if (!fs.existsSync(configPath)) {
    return { project: {}, evals: { folders: [] }, quality_rules: { enabled: [], disabled: [] } };
  }
  
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = yaml.load(raw) || {};
  
  return {
    project: parsed.project || {},
    evals: {
      folders: (parsed.evals && parsed.evals.folders) || [],
    },
    quality_rules: {
      enabled: (parsed.quality_rules && parsed.quality_rules.enabled) || [],
      disabled: (parsed.quality_rules && parsed.quality_rules.disabled) || [],
    },
  };
}

async function resolveProject(workingDirectory) {
  const projectRoot = findProjectRoot(workingDirectory);
  if (!projectRoot) return null;
  
  const config = loadProjectConfig(projectRoot);
  const displayName = config.project.name || path.basename(projectRoot);
  
  // Check for existing project
  const { rows: existing } = await query(
    'SELECT * FROM projects WHERE root_path = $1',
    [projectRoot]
  );
  
  if (existing.length > 0) {
    return { ...existing[0], config };
  }
  
  // Create new project
  const id = uuidv4();
  const { rows: created } = await query(
    'INSERT INTO projects (id, name, root_path, settings) VALUES ($1, $2, $3, $4) RETURNING *',
    [id, displayName, projectRoot, JSON.stringify({})]
  );
  
  return { ...created[0], config };
}

async function getProject(projectId) {
  const { rows } = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (rows.length === 0) return null;
  
  const project = rows[0];
  const config = loadProjectConfig(project.root_path);
  return { ...project, config };
}

async function updateProjectSettings(projectId, settings) {
  const { rows } = await query(
    'UPDATE projects SET settings = $1 WHERE id = $2 RETURNING *',
    [JSON.stringify(settings), projectId]
  );
  return rows[0] || null;
}

module.exports = {
  findProjectRoot,
  loadProjectConfig,
  resolveProject,
  getProject,
  updateProjectSettings,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/__tests__/projectDiscovery.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/projectDiscovery.js server/__tests__/projectDiscovery.test.js
git commit -m "feat: add project discovery service with .mission-control.yaml support"
```

---

### Task 4: Wire project discovery into session creation

**Files:**
- Modify: `server/routes/sessions.js`
- Modify: `server/services/sessionManager.js`

- [ ] **Step 1: Write failing test for session-project linking**

Create `server/__tests__/session-project-link.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: () => mockQuery,
}));

const mockResolveProject = vi.fn();
vi.mock('../services/projectDiscovery.js', () => ({
  resolveProject: (...args) => mockResolveProject(...args),
}));

describe('Session-project linking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolveProject is called with workingDirectory on session creation', async () => {
    mockResolveProject.mockResolvedValue({ id: 'proj-123', name: 'test', root_path: '/test', config: {} });
    mockQuery.mockResolvedValue({ rows: [{ id: 'sess-1' }] });
    
    const { linkSessionToProject } = await import('../services/projectDiscovery.js');
    // This tests the integration point — the actual wiring is in sessionManager
    const project = await mockResolveProject('/Users/me/projects/test-project');
    expect(project.id).toBe('proj-123');
    expect(mockResolveProject).toHaveBeenCalledWith('/Users/me/projects/test-project');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/session-project-link.test.js`
Expected: FAIL

- [ ] **Step 3: Wire project discovery into sessionManager.js**

In `server/services/sessionManager.js`, add at the top with other requires:

```javascript
const { resolveProject } = require('./projectDiscovery');
```

In the `createSession` function, after the session DB insert, add project linking:

```javascript
// Link session to project if .mission-control.yaml found
try {
  const project = await resolveProject(options.workingDirectory);
  if (project) {
    await query('UPDATE sessions SET project_id = $1 WHERE id = $2', [project.id, session.id]);
  }
} catch (err) {
  console.error('Failed to link session to project:', err.message);
  // Non-fatal — session still works without project
}
```

- [ ] **Step 4: Update sessions GET to include project_id in response**

In `server/routes/sessions.js`, in the GET `/api/sessions` handler, update the SQL query to include `project_id`:

The existing query already selects `*` from sessions, so `project_id` will be included automatically. No change needed to the query itself.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/__tests__/session-project-link.test.js`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add server/services/sessionManager.js server/routes/sessions.js server/__tests__/session-project-link.test.js
git commit -m "feat: wire project discovery into session creation"
```

---

### Task 5: Projects API routes

**Files:**
- Modify: `server/routes/projects.js`
- Create: `server/__tests__/projects-routes.test.js`

- [ ] **Step 1: Write failing tests for project API**

Create `server/__tests__/projects-routes.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: () => mockQuery,
}));

const mockGetProject = vi.fn();
const mockUpdateProjectSettings = vi.fn();
vi.mock('../services/projectDiscovery.js', () => ({
  getProject: (...args) => mockGetProject(...args),
  updateProjectSettings: (...args) => mockUpdateProjectSettings(...args),
  resolveProject: vi.fn(),
  findProjectRoot: vi.fn(),
  loadProjectConfig: vi.fn(),
}));

describe('Projects API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/projects/:id returns project with config', async () => {
    mockGetProject.mockResolvedValue({
      id: 'proj-123',
      name: 'event-scraper',
      root_path: '/test',
      settings: '{}',
      config: { evals: { folders: ['evals/test'] } },
    });
    
    const project = await mockGetProject('proj-123');
    expect(project.id).toBe('proj-123');
    expect(project.config.evals.folders).toEqual(['evals/test']);
  });

  it('PUT /api/projects/:id/settings updates settings', async () => {
    mockUpdateProjectSettings.mockResolvedValue({
      id: 'proj-123',
      settings: JSON.stringify({ quality_rules_overrides: { 'rule-1': { enabled: false } } }),
    });
    
    const result = await mockUpdateProjectSettings('proj-123', {
      quality_rules_overrides: { 'rule-1': { enabled: false } },
    });
    expect(result.id).toBe('proj-123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/projects-routes.test.js`
Expected: FAIL

- [ ] **Step 3: Add new endpoints to projects.js**

In `server/routes/projects.js`, add these endpoints (keep all existing endpoints):

```javascript
const { getProject, updateProjectSettings, loadProjectConfig } = require('../services/projectDiscovery');

// Get a specific project by ID
router.get('/:id', async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update project settings
router.put('/:id/settings', async (req, res) => {
  try {
    const result = await updateProjectSettings(req.params.id, req.body.settings);
    if (!result) return res.status(404).json({ error: 'Project not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get project for a session
router.get('/by-session/:sessionId', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT p.* FROM projects p JOIN sessions s ON s.project_id = p.id WHERE s.id = $1',
      [req.params.sessionId]
    );
    if (rows.length === 0) return res.json(null);
    const project = rows[0];
    const config = loadProjectConfig(project.root_path);
    res.json({ ...project, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/__tests__/projects-routes.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/routes/projects.js server/__tests__/projects-routes.test.js
git commit -m "feat: add project detail and settings API endpoints"
```

---

## Phase 2: Evals Engine

### Task 6: Eval loader — read YAML files from disk

**Files:**
- Create: `server/services/evalLoader.js`
- Create: `server/__tests__/evalLoader.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/__tests__/evalLoader.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

const mockFs = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
};
vi.mock('fs', () => ({ default: mockFs, ...mockFs }));

describe('evalLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('loadEval', () => {
    it('parses a valid eval YAML file', async () => {
      const { loadEval } = await import('../services/evalLoader.js');
      
      mockFs.readFileSync.mockReturnValue(`
name: scrape-count
description: Verify scraper found events
input:
  url: "https://example.com"
expected: "At least 15 events"
evidence:
  type: log_query
  source: session_log
  filter:
    regex: "events? found"
checks:
  - type: regex_match
    pattern: "\\\\d+ events"
    description: "Must contain event count"
judge_prompt: "Check if 15+ events found."
`);
      
      const eval_ = loadEval('/project/evals/folder/test.yaml');
      expect(eval_.name).toBe('scrape-count');
      expect(eval_.evidence.type).toBe('log_query');
      expect(eval_.checks).toHaveLength(1);
      expect(eval_.checks[0].type).toBe('regex_match');
    });

    it('rejects eval with no checks and no judge_prompt', async () => {
      const { loadEval } = await import('../services/evalLoader.js');
      
      mockFs.readFileSync.mockReturnValue(`
name: bad-eval
description: Missing assertions
input: {}
evidence:
  type: log_query
  source: session_log
`);
      
      expect(() => loadEval('/project/evals/folder/bad.yaml')).toThrow(
        /must have at least one of.*checks.*judge_prompt/i
      );
    });

    it('rejects eval with judge_prompt but no expected', async () => {
      const { loadEval } = await import('../services/evalLoader.js');
      
      mockFs.readFileSync.mockReturnValue(`
name: no-expected
description: Has judge but no expected
input: {}
evidence:
  type: log_query
  source: session_log
judge_prompt: "Check something"
`);
      
      expect(() => loadEval('/project/evals/folder/bad.yaml')).toThrow(
        /expected.*required.*judge_prompt/i
      );
    });

    it('rejects eval with unknown check type', async () => {
      const { loadEval } = await import('../services/evalLoader.js');
      
      mockFs.readFileSync.mockReturnValue(`
name: bad-check
description: Unknown check type
input: {}
evidence:
  type: log_query
  source: session_log
checks:
  - type: invented_check
    description: "Not real"
`);
      
      expect(() => loadEval('/project/evals/folder/bad.yaml')).toThrow(
        /unknown check type.*invented_check/i
      );
    });
  });

  describe('loadEvalFolder', () => {
    it('loads all YAML files in a folder', async () => {
      const { loadEvalFolder } = await import('../services/evalLoader.js');
      
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(['eval1.yaml', 'eval2.yaml', 'readme.md']);
      mockFs.statSync.mockReturnValue({ isFile: () => true });
      mockFs.readFileSync.mockImplementation((p) => {
        if (p.includes('eval1')) return 'name: eval1\ndescription: test\ninput: {}\nevidence:\n  type: log_query\n  source: session_log\nchecks:\n  - type: not_empty\n    description: "has content"';
        if (p.includes('eval2')) return 'name: eval2\ndescription: test2\ninput: {}\nevidence:\n  type: log_query\n  source: session_log\nchecks:\n  - type: not_empty\n    description: "has content"';
        return '';
      });
      
      const evals = loadEvalFolder('/project/evals/test-folder');
      expect(evals).toHaveLength(2);
      expect(evals[0].name).toBe('eval1');
      expect(evals[1].name).toBe('eval2');
    });

    it('returns empty array if folder does not exist', async () => {
      const { loadEvalFolder } = await import('../services/evalLoader.js');
      
      mockFs.existsSync.mockReturnValue(false);
      
      const evals = loadEvalFolder('/project/evals/nonexistent');
      expect(evals).toEqual([]);
    });
  });

  describe('discoverEvalFolders', () => {
    it('discovers folders from .mission-control.yaml config', async () => {
      const { discoverEvalFolders } = await import('../services/evalLoader.js');
      
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(['eval1.yaml']);
      mockFs.statSync.mockReturnValue({ isFile: () => true });
      mockFs.readFileSync.mockReturnValue('name: eval1\ndescription: test\ninput: {}\nevidence:\n  type: log_query\n  source: session_log\nchecks:\n  - type: not_empty\n    description: "has content"');
      
      const config = { evals: { folders: ['evals/onboarding', 'evals/recipes'] } };
      const folders = discoverEvalFolders('/project', config);
      
      expect(folders).toHaveLength(2);
      expect(folders[0].name).toBe('onboarding');
      expect(folders[0].path).toBe('evals/onboarding');
      expect(folders[1].name).toBe('recipes');
    });

    it('falls back to scanning evals/ directory if no config', async () => {
      const { discoverEvalFolders } = await import('../services/evalLoader.js');
      
      mockFs.existsSync.mockImplementation((p) => p === '/project/evals');
      mockFs.readdirSync.mockImplementation((p) => {
        if (p === '/project/evals') return ['folder1', 'folder2'];
        return ['eval1.yaml'];
      });
      mockFs.statSync.mockImplementation((p) => ({
        isDirectory: () => !p.endsWith('.yaml'),
        isFile: () => p.endsWith('.yaml'),
      }));
      mockFs.readFileSync.mockReturnValue('name: eval1\ndescription: test\ninput: {}\nevidence:\n  type: log_query\n  source: session_log\nchecks:\n  - type: not_empty\n    description: "has content"');
      
      const config = { evals: { folders: [] } };
      const folders = discoverEvalFolders('/project', config);
      
      expect(folders).toHaveLength(2);
      expect(folders[0].name).toBe('folder1');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/evalLoader.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement evalLoader.js**

Create `server/services/evalLoader.js`:

```javascript
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const VALID_CHECK_TYPES = ['regex_match', 'not_empty', 'json_valid', 'json_schema', 'http_status', 'field_exists'];
const VALID_EVIDENCE_TYPES = ['log_query', 'db_query', 'sub_agent', 'file'];
const VALID_LOG_SOURCES = ['session_log', 'pr_diff', 'build_output'];
const VALID_JUDGE_MODELS = ['default', 'fast', 'strong'];

function loadEval(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw);
  
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid eval file: ${filePath}`);
  }
  
  // Validate required fields
  if (!parsed.name) throw new Error(`Eval at ${filePath} missing required field: name`);
  if (!parsed.description) throw new Error(`Eval at ${filePath} missing required field: description`);
  if (!parsed.evidence) throw new Error(`Eval at ${filePath} missing required field: evidence`);
  
  // Must have checks or judge_prompt
  const hasChecks = parsed.checks && parsed.checks.length > 0;
  const hasJudge = !!parsed.judge_prompt;
  if (!hasChecks && !hasJudge) {
    throw new Error(`Eval '${parsed.name}' must have at least one of 'checks' or 'judge_prompt'`);
  }
  
  // judge_prompt requires expected
  if (hasJudge && !parsed.expected) {
    throw new Error(`Eval '${parsed.name}': 'expected' is required when judge_prompt is present`);
  }
  
  // Validate evidence type
  if (!VALID_EVIDENCE_TYPES.includes(parsed.evidence.type)) {
    throw new Error(`Eval '${parsed.name}': unknown evidence type '${parsed.evidence.type}'`);
  }
  
  // Validate check types
  if (parsed.checks) {
    for (const check of parsed.checks) {
      if (!VALID_CHECK_TYPES.includes(check.type)) {
        throw new Error(`Eval '${parsed.name}': unknown check type '${check.type}'`);
      }
    }
  }
  
  // Validate judge model if specified
  if (parsed.judge && parsed.judge.model && !VALID_JUDGE_MODELS.includes(parsed.judge.model)) {
    throw new Error(`Eval '${parsed.name}': unknown judge model '${parsed.judge.model}'. Must be one of: ${VALID_JUDGE_MODELS.join(', ')}`);
  }
  
  return {
    name: parsed.name,
    description: parsed.description,
    input: parsed.input || {},
    expected: parsed.expected || null,
    evidence: parsed.evidence,
    checks: parsed.checks || [],
    judge_prompt: parsed.judge_prompt || null,
    judge: parsed.judge || { model: 'default' },
    filePath,
  };
}

function loadEvalFolder(folderPath) {
  if (!fs.existsSync(folderPath)) return [];
  
  const files = fs.readdirSync(folderPath)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  
  return files.map(f => loadEval(path.join(folderPath, f)));
}

function discoverEvalFolders(projectRoot, config) {
  const declaredFolders = config.evals && config.evals.folders && config.evals.folders.length > 0
    ? config.evals.folders
    : null;
  
  if (declaredFolders) {
    return declaredFolders.map(folder => {
      const fullPath = path.join(projectRoot, folder);
      const evals = loadEvalFolder(fullPath);
      return {
        name: path.basename(folder),
        path: folder,
        fullPath,
        evals,
        evalCount: evals.length,
      };
    });
  }
  
  // Fallback: scan evals/ directory
  const evalsDir = path.join(projectRoot, 'evals');
  if (!fs.existsSync(evalsDir)) return [];
  
  return fs.readdirSync(evalsDir)
    .filter(f => {
      const fullPath = path.join(evalsDir, f);
      return fs.statSync(fullPath).isDirectory();
    })
    .map(folder => {
      const fullPath = path.join(evalsDir, folder);
      const evals = loadEvalFolder(fullPath);
      return {
        name: folder,
        path: `evals/${folder}`,
        fullPath,
        evals,
        evalCount: evals.length,
      };
    });
}

module.exports = {
  loadEval,
  loadEvalFolder,
  discoverEvalFolders,
  VALID_CHECK_TYPES,
  VALID_EVIDENCE_TYPES,
};
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/__tests__/evalLoader.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/evalLoader.js server/__tests__/evalLoader.test.js
git commit -m "feat: add eval loader with YAML parsing and validation"
```

---

### Task 7: Check runner — deterministic assertions

**Files:**
- Create: `server/services/evalChecks.js`
- Create: `server/__tests__/evalChecks.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/__tests__/evalChecks.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

describe('evalChecks', () => {
  describe('runCheck', () => {
    it('regex_match passes when pattern found', async () => {
      const { runCheck } = await import('../services/evalChecks.js');
      const result = runCheck({ type: 'regex_match', pattern: '\\d+ events' }, 'Found 15 events today');
      expect(result.passed).toBe(true);
    });

    it('regex_match fails when pattern not found', async () => {
      const { runCheck } = await import('../services/evalChecks.js');
      const result = runCheck({ type: 'regex_match', pattern: '\\d+ events' }, 'No events found');
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('regex_match');
    });

    it('not_empty passes for non-empty string', async () => {
      const { runCheck } = await import('../services/evalChecks.js');
      const result = runCheck({ type: 'not_empty' }, 'some content');
      expect(result.passed).toBe(true);
    });

    it('not_empty fails for empty string', async () => {
      const { runCheck } = await import('../services/evalChecks.js');
      const result = runCheck({ type: 'not_empty' }, '');
      expect(result.passed).toBe(false);
    });

    it('not_empty fails for null', async () => {
      const { runCheck } = await import('../services/evalChecks.js');
      const result = runCheck({ type: 'not_empty' }, null);
      expect(result.passed).toBe(false);
    });

    it('json_valid passes for valid JSON', async () => {
      const { runCheck } = await import('../services/evalChecks.js');
      const result = runCheck({ type: 'json_valid' }, '{"key": "value"}');
      expect(result.passed).toBe(true);
    });

    it('json_valid fails for invalid JSON', async () => {
      const { runCheck } = await import('../services/evalChecks.js');
      const result = runCheck({ type: 'json_valid' }, '{bad json}');
      expect(result.passed).toBe(false);
    });

    it('field_exists passes when field present', async () => {
      const { runCheck } = await import('../services/evalChecks.js');
      const result = runCheck({ type: 'field_exists', field: 'name' }, '{"name": "test", "value": 1}');
      expect(result.passed).toBe(true);
    });

    it('field_exists fails when field missing', async () => {
      const { runCheck } = await import('../services/evalChecks.js');
      const result = runCheck({ type: 'field_exists', field: 'missing' }, '{"name": "test"}');
      expect(result.passed).toBe(false);
    });

    it('field_exists fails when evidence is not JSON', async () => {
      const { runCheck } = await import('../services/evalChecks.js');
      const result = runCheck({ type: 'field_exists', field: 'name' }, 'not json');
      expect(result.passed).toBe(false);
    });
  });

  describe('runAllChecks', () => {
    it('runs all checks and reports all failures', async () => {
      const { runAllChecks } = await import('../services/evalChecks.js');
      const checks = [
        { type: 'not_empty', description: 'Must have content' },
        { type: 'json_valid', description: 'Must be JSON' },
        { type: 'field_exists', field: 'name', description: 'Must have name' },
      ];
      
      const results = runAllChecks(checks, 'not json');
      expect(results.allPassed).toBe(false);
      expect(results.results).toHaveLength(3);
      expect(results.results[0].passed).toBe(true);  // not_empty passes
      expect(results.results[1].passed).toBe(false); // json_valid fails
      expect(results.results[2].passed).toBe(false); // field_exists fails on non-JSON
    });

    it('all pass returns allPassed true', async () => {
      const { runAllChecks } = await import('../services/evalChecks.js');
      const checks = [
        { type: 'not_empty', description: 'Has content' },
        { type: 'json_valid', description: 'Valid JSON' },
      ];
      
      const results = runAllChecks(checks, '{"key": "value"}');
      expect(results.allPassed).toBe(true);
      expect(results.results).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/evalChecks.test.js`
Expected: FAIL

- [ ] **Step 3: Implement evalChecks.js**

Create `server/services/evalChecks.js`:

```javascript
function runCheck(check, evidence) {
  switch (check.type) {
    case 'regex_match': {
      const regex = new RegExp(check.pattern);
      const passed = regex.test(evidence || '');
      return {
        type: check.type,
        description: check.description || `regex_match: ${check.pattern}`,
        passed,
        reason: passed ? null : `regex_match failed: pattern "${check.pattern}" not found in evidence`,
      };
    }

    case 'not_empty': {
      const passed = evidence != null && evidence !== '' && evidence.length > 0;
      return {
        type: check.type,
        description: check.description || 'not_empty',
        passed,
        reason: passed ? null : 'not_empty failed: evidence is empty or null',
      };
    }

    case 'json_valid': {
      let passed = false;
      let parseError = null;
      try {
        JSON.parse(evidence);
        passed = true;
      } catch (err) {
        parseError = err.message;
      }
      return {
        type: check.type,
        description: check.description || 'json_valid',
        passed,
        reason: passed ? null : `json_valid failed: ${parseError}`,
      };
    }

    case 'json_schema': {
      // Basic schema validation — checks that evidence matches a JSON schema file
      // Full JSON Schema validation would need ajv; for now, validate it parses
      let passed = false;
      try {
        JSON.parse(evidence);
        passed = true;
        // TODO: Add ajv for full schema validation when needed
      } catch (err) {
        // falls through
      }
      return {
        type: check.type,
        description: check.description || `json_schema: ${check.schema}`,
        passed,
        reason: passed ? null : 'json_schema failed: evidence is not valid JSON',
      };
    }

    case 'http_status': {
      const passed = evidence && evidence.toString().includes(`${check.status}`);
      return {
        type: check.type,
        description: check.description || `http_status: ${check.status}`,
        passed,
        reason: passed ? null : `http_status failed: expected status ${check.status}`,
      };
    }

    case 'field_exists': {
      let passed = false;
      try {
        const parsed = JSON.parse(evidence);
        passed = check.field in parsed;
      } catch {
        // Not JSON — field can't exist
      }
      return {
        type: check.type,
        description: check.description || `field_exists: ${check.field}`,
        passed,
        reason: passed ? null : `field_exists failed: field "${check.field}" not found in evidence`,
      };
    }

    default:
      return {
        type: check.type,
        description: check.description || check.type,
        passed: false,
        reason: `Unknown check type: ${check.type}`,
      };
  }
}

function runAllChecks(checks, evidence) {
  const results = checks.map(check => runCheck(check, evidence));
  return {
    allPassed: results.every(r => r.passed),
    results,
    failures: results.filter(r => !r.passed),
  };
}

module.exports = { runCheck, runAllChecks };
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/__tests__/evalChecks.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/evalChecks.js server/__tests__/evalChecks.test.js
git commit -m "feat: add deterministic check runner for evals"
```

---

### Task 8: Evidence gatherers

**Files:**
- Create: `server/services/evidenceGatherers.js`
- Create: `server/__tests__/evidenceGatherers.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/__tests__/evidenceGatherers.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFs = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
};
vi.mock('fs', () => ({ default: mockFs, ...mockFs }));

const mockQuery = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: () => mockQuery,
}));

describe('evidenceGatherers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('gatherLogQuery', () => {
    it('reads session log and applies regex filter', async () => {
      const { gatherLogQuery } = await import('../services/evidenceGatherers.js');
      
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        'Starting scrape...\nFound 15 events from source\nCompleted in 3s\nOther stuff\n'
      );
      
      const result = await gatherLogQuery({
        source: 'session_log',
        filter: { regex: 'events?' },
      }, { sessionLogPath: '/tmp/session.log', projectRoot: '/project' });
      
      expect(result.evidence).toContain('15 events');
      expect(result.source).toBe('session_log');
      expect(result.error).toBeNull();
    });

    it('returns error when log file not found', async () => {
      const { gatherLogQuery } = await import('../services/evidenceGatherers.js');
      
      mockFs.existsSync.mockReturnValue(false);
      
      const result = await gatherLogQuery({
        source: 'session_log',
      }, { sessionLogPath: '/tmp/missing.log', projectRoot: '/project' });
      
      expect(result.error).toBeDefined();
      expect(result.evidence).toBeNull();
    });
  });

  describe('gatherFile', () => {
    it('reads file from project root', async () => {
      const { gatherFile } = await import('../services/evidenceGatherers.js');
      
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('{"pages": [{"id": 1}]}');
      
      const result = await gatherFile({
        path: 'output/pages.json',
      }, { projectRoot: '/project' });
      
      expect(result.evidence).toBe('{"pages": [{"id": 1}]}');
      expect(result.error).toBeNull();
    });

    it('returns error when file not found', async () => {
      const { gatherFile } = await import('../services/evidenceGatherers.js');
      
      mockFs.existsSync.mockReturnValue(false);
      
      const result = await gatherFile({
        path: 'output/missing.json',
      }, { projectRoot: '/project' });
      
      expect(result.error).toBeDefined();
    });
  });

  describe('gatherDbQuery', () => {
    it('refuses to run without DATABASE_URL_READONLY', async () => {
      const { gatherDbQuery } = await import('../services/evidenceGatherers.js');
      
      const result = await gatherDbQuery({
        query: 'SELECT * FROM recipes',
      }, { projectRoot: '/project', dbReadonlyUrl: null });
      
      expect(result.error).toContain('DATABASE_URL_READONLY');
    });

    it('executes query and returns results as JSON', async () => {
      const { gatherDbQuery } = await import('../services/evidenceGatherers.js');
      
      mockQuery.mockResolvedValue({ rows: [{ id: 1, name: 'test recipe' }] });
      
      const result = await gatherDbQuery({
        query: 'SELECT * FROM recipes WHERE source_url = $1',
        params: { url: 'https://example.com' },
      }, { projectRoot: '/project', dbReadonlyUrl: 'postgres://readonly@host/db', createDbConnection: () => mockQuery });
      
      expect(result.error).toBeNull();
      expect(JSON.parse(result.evidence)).toEqual([{ id: 1, name: 'test recipe' }]);
    });
  });

  describe('truncation', () => {
    it('truncates log evidence with head+tail strategy', async () => {
      const { truncateLogEvidence } = await import('../services/evidenceGatherers.js');
      
      // Create content larger than 50KB
      const lines = Array.from({ length: 2000 }, (_, i) => `Line ${i}: ${'x'.repeat(50)}`);
      const bigContent = lines.join('\n');
      
      const truncated = truncateLogEvidence(bigContent, 50 * 1024);
      expect(truncated).toContain('[truncated');
      expect(truncated.length).toBeLessThanOrEqual(55 * 1024); // Allow some overhead
    });

    it('does not truncate content under the cap', async () => {
      const { truncateLogEvidence } = await import('../services/evidenceGatherers.js');
      
      const smallContent = 'Just a few lines\nof content\n';
      const result = truncateLogEvidence(smallContent, 50 * 1024);
      expect(result).toBe(smallContent);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/evidenceGatherers.test.js`
Expected: FAIL

- [ ] **Step 3: Implement evidenceGatherers.js**

Create `server/services/evidenceGatherers.js`:

```javascript
const fs = require('fs');
const path = require('path');

const DEFAULT_CAPS = {
  log_query: 50 * 1024,
  db_query: 50 * 1024,
  sub_agent: 200 * 1024,
  file: 50 * 1024,
};

function truncateLogEvidence(content, maxBytes) {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content;
  
  const lines = content.split('\n');
  const halfBytes = Math.floor(maxBytes / 2) - 100; // Reserve space for marker
  
  let headLines = [];
  let headSize = 0;
  for (const line of lines) {
    const lineSize = Buffer.byteLength(line + '\n', 'utf8');
    if (headSize + lineSize > halfBytes) break;
    headLines.push(line);
    headSize += lineSize;
  }
  
  let tailLines = [];
  let tailSize = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineSize = Buffer.byteLength(lines[i] + '\n', 'utf8');
    if (tailSize + lineSize > halfBytes) break;
    tailLines.unshift(lines[i]);
    tailSize += lineSize;
  }
  
  const omitted = lines.length - headLines.length - tailLines.length;
  return headLines.join('\n') + `\n\n[truncated — ${omitted} lines omitted]\n\n` + tailLines.join('\n');
}

function truncateDbEvidence(rows, maxBytes) {
  const full = JSON.stringify(rows);
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full;
  
  let kept = [];
  let size = 2; // for []
  for (const row of rows) {
    const rowStr = JSON.stringify(row);
    const rowSize = Buffer.byteLength(rowStr, 'utf8') + 1; // +1 for comma
    if (size + rowSize > maxBytes - 100) break; // Reserve space for note
    kept.push(row);
    size += rowSize;
  }
  
  const omitted = rows.length - kept.length;
  if (omitted > 0) {
    kept.push({ _truncated: `${omitted} more rows omitted` });
  }
  return JSON.stringify(kept);
}

function interpolateVariables(str, context) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/\$\{([^}]+)\}/g, (match, varPath) => {
    const parts = varPath.split('.');
    let value = context;
    for (const part of parts) {
      if (value == null) return match;
      value = value[part];
    }
    return value != null ? String(value) : match;
  });
}

async function gatherLogQuery(evidenceConfig, context) {
  const { source, filter } = evidenceConfig;
  const cap = evidenceConfig.max_size || DEFAULT_CAPS.log_query;
  
  let filePath;
  if (source === 'session_log') {
    filePath = context.sessionLogPath;
  } else if (source === 'pr_diff') {
    filePath = context.prDiffPath;
  } else if (source === 'build_output') {
    filePath = context.buildOutputPath;
  } else {
    return { evidence: null, source, error: `Unknown log source: ${source}`, timestamp: new Date().toISOString() };
  }
  
  if (!filePath || !fs.existsSync(filePath)) {
    return { evidence: null, source, error: `Source file not found: ${filePath || source}`, timestamp: new Date().toISOString() };
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Apply regex filter
  if (filter && filter.regex) {
    const regex = new RegExp(filter.regex, 'gm');
    const matches = content.match(regex);
    if (matches) {
      // Include context lines around matches
      const lines = content.split('\n');
      const matchingLines = [];
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          // Include 2 lines before and after for context
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length, i + 3);
          for (let j = start; j < end; j++) {
            if (!matchingLines.includes(lines[j])) {
              matchingLines.push(lines[j]);
            }
          }
        }
        regex.lastIndex = 0; // Reset regex state
      }
      content = matchingLines.join('\n');
    } else {
      content = '';
    }
  }
  
  content = truncateLogEvidence(content, cap);
  
  return {
    evidence: content,
    source,
    error: null,
    timestamp: new Date().toISOString(),
  };
}

async function gatherFile(evidenceConfig, context) {
  const cap = evidenceConfig.max_size || DEFAULT_CAPS.file;
  const filePath = path.join(context.projectRoot, interpolateVariables(evidenceConfig.path, context.variables || {}));
  
  if (!fs.existsSync(filePath)) {
    return { evidence: null, source: `file:${evidenceConfig.path}`, error: `File not found: ${evidenceConfig.path}`, timestamp: new Date().toISOString() };
  }
  
  let content = fs.readFileSync(filePath, 'utf8');
  content = truncateLogEvidence(content, cap);
  
  return {
    evidence: content,
    source: `file:${evidenceConfig.path}`,
    error: null,
    timestamp: new Date().toISOString(),
  };
}

async function gatherDbQuery(evidenceConfig, context) {
  const cap = evidenceConfig.max_size || DEFAULT_CAPS.db_query;
  
  if (!context.dbReadonlyUrl) {
    return {
      evidence: null,
      source: 'db_query',
      error: 'DATABASE_URL_READONLY not configured — db_query evidence gatherer requires read-only database credentials',
      timestamp: new Date().toISOString(),
    };
  }
  
  try {
    const dbQuery = context.createDbConnection(context.dbReadonlyUrl);
    
    // Interpolate params
    const params = {};
    if (evidenceConfig.params) {
      for (const [key, value] of Object.entries(evidenceConfig.params)) {
        params[key] = interpolateVariables(value, context.variables || {});
      }
    }
    
    // Convert named params to positional
    let sql = evidenceConfig.query;
    const positionalParams = [];
    let paramIndex = 1;
    sql = sql.replace(/:(\w+)/g, (match, name) => {
      if (params[name] !== undefined) {
        positionalParams.push(params[name]);
        return `$${paramIndex++}`;
      }
      return match;
    });
    
    // Wrap in read-only transaction
    await dbQuery('BEGIN TRANSACTION READ ONLY');
    const { rows } = await dbQuery(sql, positionalParams);
    await dbQuery('COMMIT');
    
    const evidence = truncateDbEvidence(rows, cap);
    
    return {
      evidence,
      source: 'db_query',
      error: null,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      evidence: null,
      source: 'db_query',
      error: `Database query failed: ${err.message}`,
      timestamp: new Date().toISOString(),
    };
  }
}

async function gatherSubAgent(evidenceConfig, context) {
  const cap = evidenceConfig.max_size || DEFAULT_CAPS.sub_agent;
  const timeout = evidenceConfig.timeout || 5 * 60 * 1000; // 5 minutes default
  
  try {
    // Write context source to temp file
    const tmpDir = path.join(require('os').tmpdir(), `eval-context-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    
    let contextContent = '';
    if (evidenceConfig.context_source === 'session_log' && context.sessionLogPath) {
      if (fs.existsSync(context.sessionLogPath)) {
        contextContent = fs.readFileSync(context.sessionLogPath, 'utf8');
      }
    }
    
    const contextFile = path.join(tmpDir, 'context.txt');
    fs.writeFileSync(contextFile, contextContent);
    
    // Build extraction prompt with file path injected
    const prompt = `Read the file at ${contextFile} and follow these instructions:\n\n${evidenceConfig.extraction_prompt}`;
    
    // Spawn sandboxed Claude CLI session
    const { execSync } = require('child_process');
    const result = execSync(
      `claude --print --permission-mode plan --model claude-sonnet-4-6 -p "${prompt.replace(/"/g, '\\"')}"`,
      {
        timeout,
        cwd: tmpDir,
        env: { ...process.env, HOME: process.env.HOME },
        maxBuffer: cap + 1024,
        encoding: 'utf8',
      }
    );
    
    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    
    // Check size
    if (Buffer.byteLength(result, 'utf8') > cap) {
      return {
        evidence: null,
        source: 'sub_agent',
        error: `Evidence too large: ${Buffer.byteLength(result, 'utf8')} bytes exceeds ${cap} byte cap. Tighten the extraction prompt or increase max_size.`,
        timestamp: new Date().toISOString(),
      };
    }
    
    return {
      evidence: result.trim(),
      source: 'sub_agent',
      error: null,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    if (err.killed) {
      return { evidence: null, source: 'sub_agent', error: `Sub-agent timed out after ${timeout / 1000}s`, timestamp: new Date().toISOString() };
    }
    return { evidence: null, source: 'sub_agent', error: `Sub-agent failed: ${err.message}`, timestamp: new Date().toISOString() };
  }
}

async function gatherEvidence(evidenceConfig, context) {
  switch (evidenceConfig.type) {
    case 'log_query': return gatherLogQuery(evidenceConfig, context);
    case 'file': return gatherFile(evidenceConfig, context);
    case 'db_query': return gatherDbQuery(evidenceConfig, context);
    case 'sub_agent': return gatherSubAgent(evidenceConfig, context);
    default:
      return { evidence: null, source: evidenceConfig.type, error: `Unknown evidence type: ${evidenceConfig.type}`, timestamp: new Date().toISOString() };
  }
}

module.exports = {
  gatherEvidence,
  gatherLogQuery,
  gatherFile,
  gatherDbQuery,
  gatherSubAgent,
  truncateLogEvidence,
  truncateDbEvidence,
  interpolateVariables,
};
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/__tests__/evidenceGatherers.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/evidenceGatherers.js server/__tests__/evidenceGatherers.test.js
git commit -m "feat: add evidence gatherers for log, file, db, and sub-agent"
```

---

### Task 9: Judge service

**Files:**
- Create: `server/services/evalJudge.js`
- Create: `server/__tests__/evalJudge.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/__tests__/evalJudge.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChatCompletion = vi.fn();
vi.mock('../services/llmGateway.js', () => ({
  chatCompletion: (...args) => mockChatCompletion(...args),
}));

describe('evalJudge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('callJudge', () => {
    it('returns structured verdict on valid response', async () => {
      const { callJudge } = await import('../services/evalJudge.js');
      
      mockChatCompletion.mockResolvedValue(JSON.stringify({
        result: 'pass',
        confidence: 'high',
        reasoning: 'Evidence shows 15 events were found: "Found 15 events"',
      }));
      
      const verdict = await callJudge({
        expected: 'At least 15 events',
        evidence: 'Found 15 events from source',
        judgePrompt: 'Check if 15+ events found',
        model: 'default',
      });
      
      expect(verdict.result).toBe('pass');
      expect(verdict.confidence).toBe('high');
      expect(verdict.reasoning).toContain('15 events');
      expect(verdict.error).toBeNull();
    });

    it('handles markdown-fenced JSON response', async () => {
      const { callJudge } = await import('../services/evalJudge.js');
      
      mockChatCompletion.mockResolvedValue('```json\n{"result": "fail", "confidence": "medium", "reasoning": "Missing price field"}\n```');
      
      const verdict = await callJudge({
        expected: 'All fields present',
        evidence: '{"fields": ["name", "date"]}',
        judgePrompt: 'Check all fields',
        model: 'default',
      });
      
      expect(verdict.result).toBe('fail');
      expect(verdict.confidence).toBe('medium');
    });

    it('handles response with preamble before JSON', async () => {
      const { callJudge } = await import('../services/evalJudge.js');
      
      mockChatCompletion.mockResolvedValue('Based on my analysis:\n\n{"result": "pass", "confidence": "high", "reasoning": "All good"}');
      
      const verdict = await callJudge({
        expected: 'test',
        evidence: 'test',
        judgePrompt: 'test',
        model: 'default',
      });
      
      expect(verdict.result).toBe('pass');
    });

    it('returns error state when response cannot be parsed', async () => {
      const { callJudge } = await import('../services/evalJudge.js');
      
      mockChatCompletion.mockResolvedValue('I cannot determine the result from this evidence.');
      
      const verdict = await callJudge({
        expected: 'test',
        evidence: 'test',
        judgePrompt: 'test',
        model: 'default',
      });
      
      expect(verdict.error).toBeDefined();
      expect(verdict.rawResponse).toContain('cannot determine');
    });

    it('returns error state for invalid verdict values', async () => {
      const { callJudge } = await import('../services/evalJudge.js');
      
      mockChatCompletion.mockResolvedValue('{"result": "maybe", "confidence": "high", "reasoning": "unsure"}');
      
      const verdict = await callJudge({
        expected: 'test',
        evidence: 'test',
        judgePrompt: 'test',
        model: 'default',
      });
      
      expect(verdict.error).toBeDefined();
    });
  });

  describe('parseJudgeResponse', () => {
    it('strips markdown fences', async () => {
      const { parseJudgeResponse } = await import('../services/evalJudge.js');
      const result = parseJudgeResponse('```json\n{"result":"pass","confidence":"high","reasoning":"ok"}\n```');
      expect(result.result).toBe('pass');
    });

    it('extracts first JSON object', async () => {
      const { parseJudgeResponse } = await import('../services/evalJudge.js');
      const result = parseJudgeResponse('Here is my verdict: {"result":"fail","confidence":"low","reasoning":"bad"}');
      expect(result.result).toBe('fail');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/evalJudge.test.js`
Expected: FAIL

- [ ] **Step 3: Implement evalJudge.js**

Create `server/services/evalJudge.js`:

```javascript
const { chatCompletion } = require('./llmGateway');

const JUDGE_SYSTEM_PROMPT = `You are an evaluation judge. Your job is to determine whether gathered evidence satisfies an expected outcome. You will receive the expected outcome, the evidence, and specific judging criteria.

Evaluate strictly against the criteria provided. Do not infer intent or give partial credit unless the criteria explicitly allow it. If the evidence is ambiguous, say so and assign low confidence.

When citing evidence in your reasoning, quote the specific text from the evidence section that supports your verdict. Do not paraphrase. Every factual claim in your reasoning must reference actual text from the evidence.

Respond in exactly this JSON format:
{
  "result": "pass" or "fail",
  "confidence": "low" or "medium" or "high",
  "reasoning": "Your explanation, with direct quotes from evidence"
}`;

const MODEL_MAP = {
  default: 'claude-sonnet-4-6',
  fast: 'claude-haiku-4-5-20251001',
  strong: 'claude-opus-4-6',
};

function parseJudgeResponse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  
  // Strip markdown fences
  let cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');
  
  // Try to extract first JSON object
  const jsonMatch = cleaned.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;
  
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    
    // Validate structure
    if (!parsed.result || !parsed.confidence || !parsed.reasoning) return null;
    if (!['pass', 'fail'].includes(parsed.result)) return null;
    if (!['low', 'medium', 'high'].includes(parsed.confidence)) return null;
    
    return parsed;
  } catch {
    return null;
  }
}

async function callJudge({ expected, evidence, judgePrompt, model = 'default' }) {
  const modelId = MODEL_MAP[model] || MODEL_MAP.default;
  
  const userMessage = `## Expected Outcome\n${expected}\n\n## Evidence\n${evidence}\n\n## Judging Criteria\n${judgePrompt}`;
  
  try {
    const rawResponse = await chatCompletion({
      model: modelId,
      max_tokens: 1024,
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });
    
    const parsed = parseJudgeResponse(rawResponse);
    
    if (!parsed) {
      return {
        result: null,
        confidence: null,
        reasoning: null,
        error: 'Failed to parse judge response — response did not contain valid verdict JSON',
        rawResponse,
      };
    }
    
    return {
      result: parsed.result,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      error: null,
      rawResponse,
    };
  } catch (err) {
    return {
      result: null,
      confidence: null,
      reasoning: null,
      error: `Judge call failed: ${err.message}`,
      rawResponse: null,
    };
  }
}

module.exports = { callJudge, parseJudgeResponse, JUDGE_SYSTEM_PROMPT, MODEL_MAP };
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/__tests__/evalJudge.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/evalJudge.js server/__tests__/evalJudge.test.js
git commit -m "feat: add LLM judge service with robust response parsing"
```

---

### Task 10: Eval runner — orchestrate the pipeline

**Files:**
- Create: `server/services/evalRunner.js`
- Create: `server/__tests__/evalRunner.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/__tests__/evalRunner.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGatherEvidence = vi.fn();
vi.mock('../services/evidenceGatherers.js', () => ({
  gatherEvidence: (...args) => mockGatherEvidence(...args),
  interpolateVariables: (str) => str,
}));

const mockRunAllChecks = vi.fn();
vi.mock('../services/evalChecks.js', () => ({
  runAllChecks: (...args) => mockRunAllChecks(...args),
}));

const mockCallJudge = vi.fn();
vi.mock('../services/evalJudge.js', () => ({
  callJudge: (...args) => mockCallJudge(...args),
}));

describe('evalRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('runSingleEval', () => {
    it('returns pass when checks pass and judge passes', async () => {
      const { runSingleEval } = await import('../services/evalRunner.js');
      
      mockGatherEvidence.mockResolvedValue({ evidence: 'Found 15 events', source: 'session_log', error: null });
      mockRunAllChecks.mockReturnValue({ allPassed: true, results: [{ passed: true }], failures: [] });
      mockCallJudge.mockResolvedValue({ result: 'pass', confidence: 'high', reasoning: 'All good', error: null });
      
      const result = await runSingleEval({
        name: 'test-eval',
        evidence: { type: 'log_query', source: 'session_log' },
        checks: [{ type: 'not_empty' }],
        expected: '15 events',
        judge_prompt: 'Check events',
        judge: { model: 'default' },
        input: {},
      }, { sessionLogPath: '/tmp/log', projectRoot: '/project' });
      
      expect(result.state).toBe('pass');
      expect(result.judgeVerdict.result).toBe('pass');
    });

    it('returns error when evidence gathering fails', async () => {
      const { runSingleEval } = await import('../services/evalRunner.js');
      
      mockGatherEvidence.mockResolvedValue({ evidence: null, source: 'session_log', error: 'File not found' });
      
      const result = await runSingleEval({
        name: 'test-eval',
        evidence: { type: 'log_query', source: 'session_log' },
        checks: [],
        judge_prompt: 'test',
        expected: 'test',
        judge: { model: 'default' },
        input: {},
      }, { sessionLogPath: '/tmp/log', projectRoot: '/project' });
      
      expect(result.state).toBe('error');
      expect(result.error).toContain('File not found');
    });

    it('returns fail when evidence is empty and allow_empty is false', async () => {
      const { runSingleEval } = await import('../services/evalRunner.js');
      
      mockGatherEvidence.mockResolvedValue({ evidence: '', source: 'session_log', error: null });
      
      const result = await runSingleEval({
        name: 'test-eval',
        evidence: { type: 'log_query', source: 'session_log' },
        checks: [{ type: 'not_empty' }],
        expected: 'test',
        judge_prompt: 'test',
        judge: { model: 'default' },
        input: {},
      }, { sessionLogPath: '/tmp/log', projectRoot: '/project' });
      
      expect(result.state).toBe('fail');
      expect(result.failReason).toContain('no evidence gathered');
    });

    it('returns fail when checks fail (does not call judge)', async () => {
      const { runSingleEval } = await import('../services/evalRunner.js');
      
      mockGatherEvidence.mockResolvedValue({ evidence: 'some content', error: null });
      mockRunAllChecks.mockReturnValue({
        allPassed: false,
        results: [
          { type: 'json_valid', passed: false, reason: 'Not JSON' },
          { type: 'not_empty', passed: true, reason: null },
        ],
        failures: [{ type: 'json_valid', passed: false, reason: 'Not JSON' }],
      });
      
      const result = await runSingleEval({
        name: 'test-eval',
        evidence: { type: 'log_query', source: 'session_log' },
        checks: [{ type: 'json_valid' }, { type: 'not_empty' }],
        expected: 'test',
        judge_prompt: 'test',
        judge: { model: 'default' },
        input: {},
      }, { sessionLogPath: '/tmp/log', projectRoot: '/project' });
      
      expect(result.state).toBe('fail');
      expect(mockCallJudge).not.toHaveBeenCalled();
    });

    it('returns pass for deterministic-only eval (no judge)', async () => {
      const { runSingleEval } = await import('../services/evalRunner.js');
      
      mockGatherEvidence.mockResolvedValue({ evidence: '{"valid": true}', error: null });
      mockRunAllChecks.mockReturnValue({ allPassed: true, results: [{ passed: true }], failures: [] });
      
      const result = await runSingleEval({
        name: 'test-eval',
        evidence: { type: 'file', path: 'test.json' },
        checks: [{ type: 'json_valid' }],
        expected: null,
        judge_prompt: null,
        judge: { model: 'default' },
        input: {},
      }, { projectRoot: '/project' });
      
      expect(result.state).toBe('pass');
      expect(mockCallJudge).not.toHaveBeenCalled();
    });

    it('returns error when judge response cannot be parsed', async () => {
      const { runSingleEval } = await import('../services/evalRunner.js');
      
      mockGatherEvidence.mockResolvedValue({ evidence: 'data', error: null });
      mockRunAllChecks.mockReturnValue({ allPassed: true, results: [], failures: [] });
      mockCallJudge.mockResolvedValue({ result: null, error: 'Failed to parse', rawResponse: 'gibberish' });
      
      const result = await runSingleEval({
        name: 'test-eval',
        evidence: { type: 'log_query', source: 'session_log' },
        checks: [],
        expected: 'test',
        judge_prompt: 'test',
        judge: { model: 'default' },
        input: {},
      }, { sessionLogPath: '/tmp/log', projectRoot: '/project' });
      
      expect(result.state).toBe('error');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/evalRunner.test.js`
Expected: FAIL

- [ ] **Step 3: Implement evalRunner.js**

Create `server/services/evalRunner.js`:

```javascript
const { gatherEvidence, interpolateVariables } = require('./evidenceGatherers');
const { runAllChecks } = require('./evalChecks');
const { callJudge } = require('./evalJudge');

async function runSingleEval(evalDef, context) {
  const startTime = Date.now();
  const evalName = evalDef.name;
  
  // Build interpolation context
  const variables = {
    input: evalDef.input || {},
    eval: { name: evalName },
    run: context.run || {},
    project: { root: context.projectRoot },
  };
  const fullContext = { ...context, variables };
  
  // Step 1: Gather evidence
  let evidenceResult;
  try {
    evidenceResult = await gatherEvidence(evalDef.evidence, fullContext);
  } catch (err) {
    return buildResult(evalName, 'error', {
      error: `Evidence gathering crashed: ${err.message}`,
      duration: Date.now() - startTime,
    });
  }
  
  // Step 2: Evidence gathering error
  if (evidenceResult.error) {
    return buildResult(evalName, 'error', {
      error: evidenceResult.error,
      evidence: evidenceResult,
      duration: Date.now() - startTime,
    });
  }
  
  // Step 3: Empty evidence check
  const allowEmpty = evalDef.evidence.allow_empty === true;
  if (!allowEmpty && (!evidenceResult.evidence || evidenceResult.evidence.trim() === '')) {
    return buildResult(evalName, 'fail', {
      failReason: 'no evidence gathered',
      evidence: evidenceResult,
      duration: Date.now() - startTime,
    });
  }
  
  // Step 4: Run all checks
  let checkResults = { allPassed: true, results: [], failures: [] };
  if (evalDef.checks && evalDef.checks.length > 0) {
    checkResults = runAllChecks(evalDef.checks, evidenceResult.evidence);
  }
  
  // Step 5: Check failures
  if (!checkResults.allPassed) {
    return buildResult(evalName, 'fail', {
      failReason: 'check_failure',
      checkResults: checkResults.results,
      checkFailures: checkResults.failures,
      evidence: evidenceResult,
      duration: Date.now() - startTime,
    });
  }
  
  // Step 6: No judge — deterministic-only eval passes
  if (!evalDef.judge_prompt) {
    return buildResult(evalName, 'pass', {
      checkResults: checkResults.results,
      evidence: evidenceResult,
      duration: Date.now() - startTime,
    });
  }
  
  // Step 7: Call judge
  const judgeVerdict = await callJudge({
    expected: evalDef.expected,
    evidence: evidenceResult.evidence,
    judgePrompt: evalDef.judge_prompt,
    model: (evalDef.judge && evalDef.judge.model) || 'default',
  });
  
  // Step 8-9: Parse errors
  if (judgeVerdict.error) {
    return buildResult(evalName, 'error', {
      error: judgeVerdict.error,
      rawResponse: judgeVerdict.rawResponse,
      evidence: evidenceResult,
      checkResults: checkResults.results,
      duration: Date.now() - startTime,
    });
  }
  
  // Step 10: Record verdict
  return buildResult(evalName, judgeVerdict.result, {
    judgeVerdict,
    checkResults: checkResults.results,
    evidence: evidenceResult,
    duration: Date.now() - startTime,
  });
}

function buildResult(evalName, state, details = {}) {
  return {
    evalName,
    state, // 'pass', 'fail', 'error'
    error: details.error || null,
    failReason: details.failReason || null,
    evidence: details.evidence || null,
    checkResults: details.checkResults || [],
    checkFailures: details.checkFailures || [],
    judgeVerdict: details.judgeVerdict || null,
    rawResponse: details.rawResponse || null,
    duration: details.duration || 0,
    timestamp: new Date().toISOString(),
  };
}

async function runEvalBatch(evals, context) {
  const results = await Promise.all(
    evals.map(evalDef => runSingleEval(evalDef, context))
  );
  
  return {
    results,
    summary: {
      total: results.length,
      passed: results.filter(r => r.state === 'pass').length,
      failed: results.filter(r => r.state === 'fail').length,
      errors: results.filter(r => r.state === 'error').length,
    },
    timestamp: new Date().toISOString(),
  };
}

module.exports = { runSingleEval, runEvalBatch };
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/__tests__/evalRunner.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/evalRunner.js server/__tests__/evalRunner.test.js
git commit -m "feat: add eval runner orchestrating evidence → checks → judge pipeline"
```

---

## Phase 3: Storage, Orchestration & Reporting

### Task 11: Eval runs database tables

**Files:**
- Modify: `server/database.js`

- [ ] **Step 1: Add eval tables to database.js**

In `server/database.js`, add to the statements array inside `initializeDb()`:

```javascript
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
`CREATE INDEX IF NOT EXISTS idx_eval_batches_project ON eval_batches(project_id)`,
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add server/database.js
git commit -m "feat: add eval_armed_folders, eval_batches, and eval_runs tables"
```

---

### Task 12: Eval API routes

**Files:**
- Create: `server/routes/evals.js`
- Modify: `server/index.js`

- [ ] **Step 1: Create evals route file**

Create `server/routes/evals.js`:

```javascript
const express = require('express');
const router = express.Router();
const { query } = require('../database');
const { v4: uuidv4 } = require('uuid');
const { getProject, loadProjectConfig } = require('../services/projectDiscovery');
const { discoverEvalFolders, loadEvalFolder } = require('../services/evalLoader');
const { runEvalBatch } = require('../services/evalRunner');
const { composeFailureMessage } = require('../services/evalReporter');
const path = require('path');

// Get eval folders for a project
router.get('/folders/:projectId', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    
    const folders = discoverEvalFolders(project.root_path, project.config);
    
    // Merge with armed state from DB
    const { rows: armed } = await query(
      'SELECT * FROM eval_armed_folders WHERE project_id = $1',
      [project.id]
    );
    const armedMap = new Map(armed.map(a => [a.folder_path, a]));
    
    const enriched = folders.map(f => ({
      ...f,
      armed: armedMap.has(f.path),
      triggers: armedMap.get(f.path)?.triggers || 'manual',
      autoSend: armedMap.get(f.path)?.auto_send === 1,
      armedId: armedMap.get(f.path)?.id || null,
    }));
    
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Arm/disarm a folder
router.post('/folders/:projectId/arm', async (req, res) => {
  try {
    const { folderPath, folderName, triggers, autoSend } = req.body;
    const id = uuidv4();
    
    await query(
      `INSERT INTO eval_armed_folders (id, project_id, folder_path, folder_name, triggers, auto_send)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (project_id, folder_path) DO UPDATE SET triggers = $5, auto_send = $6`,
      [id, req.params.projectId, folderPath, folderName, triggers || 'manual', autoSend ? 1 : 0]
    );
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/folders/:projectId/disarm', async (req, res) => {
  try {
    const { folderPath } = req.body;
    await query(
      'DELETE FROM eval_armed_folders WHERE project_id = $1 AND folder_path = $2',
      [req.params.projectId, folderPath]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update folder settings (triggers, auto-send)
router.put('/folders/:projectId/settings', async (req, res) => {
  try {
    const { folderPath, triggers, autoSend } = req.body;
    await query(
      'UPDATE eval_armed_folders SET triggers = $1, auto_send = $2 WHERE project_id = $3 AND folder_path = $4',
      [triggers, autoSend ? 1 : 0, req.params.projectId, folderPath]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run armed evals manually
router.post('/run/:projectId', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    
    const { rows: armed } = await query(
      'SELECT * FROM eval_armed_folders WHERE project_id = $1',
      [project.id]
    );
    
    if (armed.length === 0) return res.json({ message: 'No armed folders', results: null });
    
    // Check if a batch is already running
    const { rows: running } = await query(
      "SELECT id FROM eval_batches WHERE project_id = $1 AND status = 'running'",
      [project.id]
    );
    if (running.length > 0) return res.status(409).json({ error: 'Eval batch already running' });
    
    // Get commit SHA
    let commitSha = null;
    try {
      const { execSync } = require('child_process');
      commitSha = execSync('git rev-parse --short HEAD', { cwd: project.root_path, encoding: 'utf8' }).trim();
    } catch {}
    
    // Create batch
    const batchId = uuidv4();
    await query(
      'INSERT INTO eval_batches (id, project_id, trigger_source, commit_sha, session_id) VALUES ($1, $2, $3, $4, $5)',
      [batchId, project.id, 'manual', commitSha, req.body.sessionId || null]
    );
    
    // Load all evals from armed folders
    const allEvals = [];
    for (const folder of armed) {
      const fullPath = path.join(project.root_path, folder.folder_path);
      const evals = loadEvalFolder(fullPath);
      evals.forEach(e => allEvals.push({ ...e, folder: folder.folder_path, folderName: folder.folder_name }));
    }
    
    // Build context
    const sessionLogPath = req.body.sessionId
      ? path.join(project.root_path, '.tmux-outputs', `${req.body.sessionId}.jsonl`)
      : null;
    
    const context = {
      projectRoot: project.root_path,
      sessionLogPath,
      run: { commit_sha: commitSha, trigger: 'manual' },
    };
    
    // Run batch
    const batchResult = await runEvalBatch(allEvals, context);
    
    // Store individual runs
    for (const result of batchResult.results) {
      const evalDef = allEvals.find(e => e.name === result.evalName);
      await query(
        `INSERT INTO eval_runs (id, batch_id, eval_name, eval_folder, commit_sha, trigger_source, input, evidence, check_results, judge_verdict, state, fail_reason, error_message, duration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          uuidv4(), batchId, result.evalName, evalDef?.folder || 'unknown',
          commitSha, 'manual',
          JSON.stringify(evalDef?.input || {}),
          JSON.stringify(result.evidence),
          JSON.stringify(result.checkResults),
          result.judgeVerdict ? JSON.stringify(result.judgeVerdict) : null,
          result.state,
          result.failReason,
          result.error,
          result.duration,
        ]
      );
    }
    
    // Update batch
    await query(
      'UPDATE eval_batches SET total = $1, passed = $2, failed = $3, errors = $4, completed_at = NOW(), status = $5 WHERE id = $6',
      [batchResult.summary.total, batchResult.summary.passed, batchResult.summary.failed, batchResult.summary.errors, 'completed', batchId]
    );
    
    res.json({ batchId, ...batchResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get run history for a project
router.get('/history/:projectId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const { rows: batches } = await query(
      'SELECT * FROM eval_batches WHERE project_id = $1 ORDER BY started_at DESC LIMIT $2',
      [req.params.projectId, limit]
    );
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get runs for a specific batch
router.get('/batch/:batchId', async (req, res) => {
  try {
    const { rows: runs } = await query(
      'SELECT * FROM eval_runs WHERE batch_id = $1 ORDER BY eval_name',
      [req.params.batchId]
    );
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get last N runs for a specific eval
router.get('/eval-history/:projectId/:evalName', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 3;
    const { rows } = await query(
      `SELECT er.*, eb.trigger_source as batch_trigger
       FROM eval_runs er
       JOIN eval_batches eb ON er.batch_id = eb.id
       WHERE eb.project_id = $1 AND er.eval_name = $2
       ORDER BY er.timestamp DESC LIMIT $3`,
      [req.params.projectId, req.params.evalName, limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 2: Register route in index.js**

In `server/index.js`, add with the other route registrations:

```javascript
app.use('/api/evals', require('./routes/evals'));
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add server/routes/evals.js server/index.js
git commit -m "feat: add eval API routes for folders, arming, running, and history"
```

---

### Task 13: Failure message composer

**Files:**
- Create: `server/services/evalReporter.js`
- Create: `server/__tests__/evalReporter.test.js`

- [ ] **Step 1: Write failing tests**

Create `server/__tests__/evalReporter.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

describe('evalReporter', () => {
  describe('composeFailureMessage', () => {
    it('composes message with passed, failed, and error evals', async () => {
      const { composeFailureMessage } = await import('../services/evalReporter.js');
      
      const results = [
        { evalName: 'scrape-count', evalFolder: 'event-onboarding', state: 'pass' },
        {
          evalName: 'recipe-check',
          evalFolder: 'recipe-extraction',
          state: 'fail',
          failReason: null,
          evidence: { evidence: '{"fields": ["name"]}' },
          judgeVerdict: { result: 'fail', confidence: 'high', reasoning: 'Missing price field' },
          checkFailures: [],
        },
        {
          evalName: 'build-check',
          evalFolder: 'event-onboarding',
          state: 'error',
          error: 'File not found',
        },
      ];
      
      const history = {
        'scrape-count': [
          { state: 'pass', commit_sha: 'abc123' },
          { state: 'pass', commit_sha: 'def456' },
          { state: 'pass', commit_sha: 'ghi789' },
        ],
        'recipe-check': [
          { state: 'pass', commit_sha: 'abc123' },
          { state: 'pass', commit_sha: 'def456' },
          { state: 'fail', commit_sha: 'ghi789' },
        ],
        'build-check': [
          { state: 'pass', commit_sha: 'abc123' },
          { state: 'pass', commit_sha: 'def456' },
          { state: 'error', commit_sha: 'ghi789' },
        ],
      };
      
      const message = composeFailureMessage(results, history, { total: 3, failed: 1, errors: 1, passed: 1 });
      
      expect(message).toContain('3 evals ran');
      expect(message).toContain('1 failed');
      expect(message).toContain('1 error');
      expect(message).toContain('PASSED: scrape-count');
      expect(message).toContain('FAILED: recipe-check');
      expect(message).toContain('ERROR: build-check');
      expect(message).toContain('LAST 3 RUNS');
      expect(message).toContain('abc123');
    });

    it('flags low confidence verdicts', async () => {
      const { composeFailureMessage } = await import('../services/evalReporter.js');
      
      const results = [
        {
          evalName: 'fuzzy-eval',
          evalFolder: 'test',
          state: 'fail',
          judgeVerdict: { result: 'fail', confidence: 'low', reasoning: 'Unsure' },
          checkFailures: [],
        },
      ];
      
      const message = composeFailureMessage(results, { 'fuzzy-eval': [] }, { total: 1, failed: 1, errors: 0, passed: 0 });
      expect(message).toContain('low');
      expect(message).toContain('verify before acting');
    });

    it('shows check failures without judge', async () => {
      const { composeFailureMessage } = await import('../services/evalReporter.js');
      
      const results = [
        {
          evalName: 'check-only',
          evalFolder: 'test',
          state: 'fail',
          failReason: 'check_failure',
          checkFailures: [{ type: 'regex_match', reason: 'pattern not found' }],
          judgeVerdict: null,
        },
      ];
      
      const message = composeFailureMessage(results, { 'check-only': [] }, { total: 1, failed: 1, errors: 0, passed: 0 });
      expect(message).toContain('Check failure');
      expect(message).toContain('regex_match');
      expect(message).toContain('Judge was not invoked');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/evalReporter.test.js`
Expected: FAIL

- [ ] **Step 3: Implement evalReporter.js**

Create `server/services/evalReporter.js`:

```javascript
function composeFailureMessage(results, history, summary) {
  const lines = [];
  
  // Summary line
  lines.push(`Eval run complete: ${summary.total} evals ran, ${summary.failed} failed, ${summary.errors} error${summary.errors !== 1 ? 's' : ''}.`);
  lines.push('');
  
  // Passed evals
  const passed = results.filter(r => r.state === 'pass');
  for (const r of passed) {
    lines.push(`PASSED: ${r.evalName} (${r.evalFolder}/)`);
  }
  if (passed.length > 0) lines.push('');
  
  // Failed evals with details
  const failed = results.filter(r => r.state === 'fail');
  for (const r of failed) {
    lines.push(`FAILED: ${r.evalName} (${r.evalFolder}/)`);
    
    if (r.failReason === 'check_failure' && r.checkFailures && r.checkFailures.length > 0) {
      for (const cf of r.checkFailures) {
        lines.push(`Check failure: ${cf.type} — ${cf.reason}`);
      }
      lines.push('(Judge was not invoked — structural check failed)');
    } else if (r.failReason === 'no evidence gathered') {
      lines.push('No evidence was gathered for this eval.');
    } else if (r.judgeVerdict) {
      if (r.evidence && r.evidence.evidence) {
        const evidencePreview = r.evidence.evidence.length > 200
          ? r.evidence.evidence.substring(0, 200) + '...'
          : r.evidence.evidence;
        lines.push(`Evidence: ${evidencePreview}`);
      }
      lines.push(`Judge reasoning: "${r.judgeVerdict.reasoning}"`);
      lines.push(`Confidence: ${r.judgeVerdict.confidence}`);
      if (r.judgeVerdict.confidence === 'low') {
        lines.push('⚠ Judge confidence was low — verify before acting on this result.');
      }
    }
    lines.push('');
  }
  
  // Error evals
  const errors = results.filter(r => r.state === 'error');
  for (const r of errors) {
    lines.push(`ERROR: ${r.evalName} (${r.evalFolder}/)`);
    lines.push(`${r.error || 'Unknown error'}`);
    lines.push('(Infrastructure issue, not a regression)');
    lines.push('');
  }
  
  // Last 3 runs
  const allEvalNames = results.map(r => r.evalName);
  if (allEvalNames.length > 0) {
    lines.push('LAST 3 RUNS:');
    const maxNameLen = Math.max(...allEvalNames.map(n => n.length));
    
    for (const evalName of allEvalNames) {
      const runs = history[evalName] || [];
      const pad = ' '.repeat(maxNameLen - evalName.length);
      
      if (runs.length === 0) {
        lines.push(`  ${evalName}:${pad}    (no previous runs)`);
      } else {
        const runStrs = runs.map(r => `${r.state.toUpperCase()} ${r.commit_sha || '?'}`);
        lines.push(`  ${evalName}:${pad}    ${runStrs.join(' → ')}`);
      }
    }
  }
  
  return lines.join('\n');
}

module.exports = { composeFailureMessage };
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/__tests__/evalReporter.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/evalReporter.js server/__tests__/evalReporter.test.js
git commit -m "feat: add eval failure message composer"
```

---

### Task 14: Trigger integration — wire evals to session end

**Files:**
- Modify: `server/services/sessionManager.js`
- Modify: `server/routes/evals.js`

- [ ] **Step 1: Create trigger helper in evals route**

Add to `server/routes/evals.js` a new exported function `triggerEvalRun`:

```javascript
const { composeFailureMessage } = require('../services/evalReporter');

async function triggerEvalRun(projectId, triggerSource, sessionId, tmuxSessionName) {
  // Check for armed folders with this trigger
  const { rows: armed } = await query(
    'SELECT * FROM eval_armed_folders WHERE project_id = $1 AND triggers LIKE $2',
    [projectId, `%${triggerSource}%`]
  );
  
  if (armed.length === 0) return null;
  
  // Check if batch already running
  const { rows: running } = await query(
    "SELECT id FROM eval_batches WHERE project_id = $1 AND status = 'running'",
    [projectId]
  );
  if (running.length > 0) return null; // Triggers disabled during batch
  
  const { getProject } = require('../services/projectDiscovery');
  const project = await getProject(projectId);
  if (!project) return null;
  
  // Get commit SHA
  let commitSha = null;
  try {
    const { execSync } = require('child_process');
    commitSha = execSync('git rev-parse --short HEAD', { cwd: project.root_path, encoding: 'utf8' }).trim();
  } catch {}
  
  // Create batch
  const batchId = uuidv4();
  await query(
    'INSERT INTO eval_batches (id, project_id, trigger_source, commit_sha, session_id) VALUES ($1, $2, $3, $4, $5)',
    [batchId, projectId, triggerSource, commitSha, sessionId]
  );
  
  // Load and run evals
  const allEvals = [];
  for (const folder of armed) {
    const fullPath = path.join(project.root_path, folder.folder_path);
    const { loadEvalFolder } = require('../services/evalLoader');
    const evals = loadEvalFolder(fullPath);
    evals.forEach(e => allEvals.push({ ...e, folder: folder.folder_path, folderName: folder.folder_name, autoSend: folder.auto_send === 1 }));
  }
  
  const sessionLogPath = sessionId
    ? path.join(project.root_path, '.tmux-outputs', `${sessionId}.jsonl`)
    : null;
  
  const context = {
    projectRoot: project.root_path,
    sessionLogPath,
    run: { commit_sha: commitSha, trigger: triggerSource },
  };
  
  const { runEvalBatch } = require('../services/evalRunner');
  const batchResult = await runEvalBatch(allEvals, context);
  
  // Store runs
  for (const result of batchResult.results) {
    const evalDef = allEvals.find(e => e.name === result.evalName);
    await query(
      `INSERT INTO eval_runs (id, batch_id, eval_name, eval_folder, commit_sha, trigger_source, input, evidence, check_results, judge_verdict, state, fail_reason, error_message, duration)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        uuidv4(), batchId, result.evalName, evalDef?.folder || 'unknown',
        commitSha, triggerSource,
        JSON.stringify(evalDef?.input || {}),
        JSON.stringify(result.evidence),
        JSON.stringify(result.checkResults),
        result.judgeVerdict ? JSON.stringify(result.judgeVerdict) : null,
        result.state, result.failReason, result.error, result.duration,
      ]
    );
  }
  
  // Update batch
  await query(
    'UPDATE eval_batches SET total = $1, passed = $2, failed = $3, errors = $4, completed_at = NOW(), status = $5 WHERE id = $6',
    [batchResult.summary.total, batchResult.summary.passed, batchResult.summary.failed, batchResult.summary.errors, 'completed', batchId]
  );
  
  // Compose and send failure message if needed
  if (batchResult.summary.failed > 0 || batchResult.summary.errors > 0) {
    const shouldSend = allEvals.some(e => e.autoSend);
    
    if (shouldSend && tmuxSessionName) {
      // Get history for each eval
      const history = {};
      for (const result of batchResult.results) {
        const { rows: evalHistory } = await query(
          `SELECT er.state, er.commit_sha FROM eval_runs er
           JOIN eval_batches eb ON er.batch_id = eb.id
           WHERE eb.project_id = $1 AND er.eval_name = $2 AND er.id != $3
           ORDER BY er.timestamp DESC LIMIT 3`,
          [projectId, result.evalName, batchId]
        );
        history[result.evalName] = evalHistory;
      }
      
      const resultsWithFolder = batchResult.results.map(r => {
        const evalDef = allEvals.find(e => e.name === r.evalName);
        return { ...r, evalFolder: evalDef?.folder || 'unknown' };
      });
      
      const message = composeFailureMessage(resultsWithFolder, history, batchResult.summary);
      
      // Send to tmux session
      try {
        const { execSync } = require('child_process');
        // Escape the message for tmux send-keys
        const escaped = message.replace(/'/g, "'\\''");
        execSync(`tmux send-keys -t ${tmuxSessionName} '${escaped}' Enter`, { timeout: 5000 });
      } catch (err) {
        console.error('Failed to send eval results to tmux:', err.message);
      }
    }
  }
  
  return { batchId, ...batchResult };
}

module.exports = router;
module.exports.triggerEvalRun = triggerEvalRun;
```

- [ ] **Step 2: Wire session end trigger in sessionManager.js**

In `server/services/sessionManager.js`, in the session end/stop handler, after quality rules run, add:

```javascript
// Trigger evals if session has a project
if (session.project_id) {
  try {
    const { triggerEvalRun } = require('../routes/evals');
    const tmuxName = this.tmuxSessionName || await this.getTmuxName();
    triggerEvalRun(session.project_id, 'session_end', session.id, tmuxName)
      .catch(err => console.error('Eval trigger failed:', err.message));
  } catch (err) {
    console.error('Failed to trigger evals on session end:', err.message);
  }
}
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add server/routes/evals.js server/services/sessionManager.js
git commit -m "feat: wire eval triggers to session end with tmux message delivery"
```

---

## Phase 4: Quality Tab UI

### Task 15: Add Quality tab to session view

**Files:**
- Modify: `client/src/components/Layout/Layout.jsx`
- Create: `client/src/components/Quality/QualityTab.jsx`
- Create: `client/src/components/Quality/QualityTab.module.css`

- [ ] **Step 1: Add Quality tab option to Layout.jsx**

In `client/src/components/Layout/Layout.jsx`, update `RIGHT_PANEL_TABS`:

```javascript
const RIGHT_PANEL_TABS = [
  { value: 'files', label: 'Files' },
  { value: 'preview', label: 'Preview' },
  { value: 'cli', label: 'CLI' },
  { value: 'quality', label: 'Quality' },
];
```

Add the import and rendering:

```javascript
import QualityTab from '../Quality/QualityTab';
```

In the tab content conditional rendering section, add:

```javascript
{rightPanelMode === 'quality' && selectedSession && (
  <QualityTab sessionId={selectedSession.id} session={selectedSession} />
)}
```

- [ ] **Step 2: Create QualityTab component**

Create `client/src/components/Quality/QualityTab.jsx`:

```jsx
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../utils/api';
import { ChevronDown, ChevronRight, Play, Shield, FlaskConical, ToggleLeft, ToggleRight } from 'lucide-react';
import styles from './QualityTab.module.css';

export default function QualityTab({ sessionId, session }) {
  const [project, setProject] = useState(null);
  const [evalFolders, setEvalFolders] = useState([]);
  const [runHistory, setRunHistory] = useState([]);
  const [rulesExpanded, setRulesExpanded] = useState(false);
  const [evalsExpanded, setEvalsExpanded] = useState(true);
  const [historyExpanded, setHistoryExpanded] = useState(true);
  const [expandedFolders, setExpandedFolders] = useState(new Set());
  const [expandedBatches, setExpandedBatches] = useState(new Set());
  const [batchRuns, setBatchRuns] = useState({});
  const [running, setRunning] = useState(false);
  const [qualityRules, setQualityRules] = useState([]);

  const loadData = useCallback(async () => {
    try {
      const proj = await api.get(`/api/projects/by-session/${sessionId}`);
      setProject(proj);
      
      if (proj) {
        const [folders, history, rules] = await Promise.all([
          api.get(`/api/evals/folders/${proj.id}`),
          api.get(`/api/evals/history/${proj.id}?limit=10`),
          api.get('/api/quality/rules'),
        ]);
        setEvalFolders(folders);
        setRunHistory(history);
        setQualityRules(rules);
      }
    } catch (err) {
      console.error('Failed to load quality tab data:', err);
    }
  }, [sessionId]);

  useEffect(() => { loadData(); }, [loadData]);

  // Poll for updates every 15s
  useEffect(() => {
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleArm = async (folder) => {
    if (folder.armed) {
      await api.post(`/api/evals/folders/${project.id}/disarm`, { folderPath: folder.path });
    } else {
      await api.post(`/api/evals/folders/${project.id}/arm`, {
        folderPath: folder.path,
        folderName: folder.name,
        triggers: 'session_end',
        autoSend: true,
      });
    }
    loadData();
  };

  const handleTriggerChange = async (folder, triggers) => {
    await api.put(`/api/evals/folders/${project.id}/settings`, {
      folderPath: folder.path,
      triggers,
      autoSend: folder.autoSend,
    });
    loadData();
  };

  const handleAutoSendToggle = async (folder) => {
    await api.put(`/api/evals/folders/${project.id}/settings`, {
      folderPath: folder.path,
      triggers: folder.triggers,
      autoSend: !folder.autoSend,
    });
    loadData();
  };

  const handleRunArmed = async () => {
    if (!project || running) return;
    setRunning(true);
    try {
      await api.post(`/api/evals/run/${project.id}`, { sessionId });
      await loadData();
    } catch (err) {
      console.error('Eval run failed:', err);
    }
    setRunning(false);
  };

  const loadBatchRuns = async (batchId) => {
    if (batchRuns[batchId]) {
      setExpandedBatches(prev => { const next = new Set(prev); next.delete(batchId); return next; });
      return;
    }
    const runs = await api.get(`/api/evals/batch/${batchId}`);
    setBatchRuns(prev => ({ ...prev, [batchId]: runs }));
    setExpandedBatches(prev => new Set([...prev, batchId]));
  };

  const toggleFolder = (folderPath) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  if (!project) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>
          No project linked to this session. Add a <code>.mission-control.yaml</code> to your project root.
        </div>
      </div>
    );
  }

  const stateColor = (state) => {
    if (state === 'pass') return styles.pass;
    if (state === 'fail') return styles.fail;
    if (state === 'error') return styles.error;
    return '';
  };

  return (
    <div className={styles.container}>
      {/* Run button */}
      <div className={styles.header}>
        <button className={styles.runButton} onClick={handleRunArmed} disabled={running}>
          <Play size={14} />
          {running ? 'Running...' : 'Run Armed Evals'}
        </button>
      </div>

      {/* Quality Rules Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader} onClick={() => setRulesExpanded(!rulesExpanded)}>
          {rulesExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Shield size={14} />
          <span className={styles.sectionTitle}>Quality Rules</span>
          <span className={styles.badge}>{qualityRules.filter(r => r.enabled).length} active</span>
        </div>
        {rulesExpanded && (
          <div className={styles.sectionContent}>
            {qualityRules.map(rule => (
              <div key={rule.id} className={styles.ruleRow}>
                <span className={`${styles.dot} ${rule.enabled ? styles.pass : styles.disabled}`} />
                <span className={styles.ruleName}>{rule.name}</span>
                <span className={styles.severityBadge} data-severity={rule.severity}>{rule.severity}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Eval Folders Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader} onClick={() => setEvalsExpanded(!evalsExpanded)}>
          {evalsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <FlaskConical size={14} />
          <span className={styles.sectionTitle}>Eval Folders</span>
          <span className={styles.badge}>{evalFolders.length} folders · {evalFolders.filter(f => f.armed).length} armed</span>
        </div>
        {evalsExpanded && (
          <div className={styles.sectionContent}>
            {evalFolders.map(folder => (
              <div key={folder.path} className={styles.folderCard}>
                <div className={styles.folderHeader}>
                  <button
                    className={`${styles.toggle} ${folder.armed ? styles.toggleOn : ''}`}
                    onClick={() => handleArm(folder)}
                  >
                    {folder.armed ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                  </button>
                  <div className={styles.folderInfo} onClick={() => toggleFolder(folder.path)}>
                    <span className={`${styles.folderName} ${!folder.armed ? styles.disarmed : ''}`}>
                      {folder.name}
                    </span>
                    <span className={styles.evalCount}>{folder.evalCount} evals</span>
                  </div>
                  {folder.armed && (
                    <div className={styles.folderControls}>
                      {folder.triggers.split(',').map(t => t.trim()).filter(Boolean).map(t => (
                        <span key={t} className={styles.triggerPill}>{t}</span>
                      ))}
                      <button
                        className={`${styles.autoSendBtn} ${folder.autoSend ? styles.autoSendOn : ''}`}
                        onClick={() => handleAutoSendToggle(folder)}
                      >
                        auto-send: {folder.autoSend ? 'on' : 'off'}
                      </button>
                    </div>
                  )}
                </div>
                {expandedFolders.has(folder.path) && folder.evals && (
                  <div className={styles.evalList}>
                    {folder.evals.map(ev => (
                      <div key={ev.name} className={styles.evalRow}>
                        <span className={styles.evidenceType}>{ev.evidence.type}</span>
                        <span className={styles.evalName}>{ev.name}</span>
                        <span className={styles.evalDesc}>{ev.description}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {evalFolders.length === 0 && (
              <div className={styles.emptyNote}>No eval folders found. Add YAML evals to your project's evals/ directory.</div>
            )}
          </div>
        )}
      </div>

      {/* Run History Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader} onClick={() => setHistoryExpanded(!historyExpanded)}>
          {historyExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className={styles.sectionTitle}>Run History</span>
        </div>
        {historyExpanded && (
          <div className={styles.sectionContent}>
            {runHistory.map(batch => (
              <div key={batch.id} className={styles.batchRow}>
                <div className={styles.batchHeader} onClick={() => loadBatchRuns(batch.id)}>
                  <span className={styles.batchLabel}>
                    {batch.trigger_source} · {batch.commit_sha || '?'} · {new Date(batch.started_at).toLocaleString()}
                  </span>
                  <div className={styles.batchSummary}>
                    {batch.passed > 0 && <span className={styles.pass}>{batch.passed} passed</span>}
                    {batch.failed > 0 && <span className={styles.fail}>{batch.failed} failed</span>}
                    {batch.errors > 0 && <span className={styles.error}>{batch.errors} errors</span>}
                  </div>
                </div>
                {expandedBatches.has(batch.id) && batchRuns[batch.id] && (
                  <div className={styles.batchRuns}>
                    {batchRuns[batch.id].map(run => (
                      <div key={run.id} className={styles.runRow}>
                        <span className={`${styles.stateDot} ${stateColor(run.state)}`} />
                        <span className={styles.runName}>{run.eval_name}</span>
                        <span className={styles.runFolder}>{run.eval_folder}</span>
                        {run.judge_verdict && (() => {
                          try {
                            const v = JSON.parse(run.judge_verdict);
                            return <span className={styles.confidence}>{v.confidence}</span>;
                          } catch { return null; }
                        })()}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {runHistory.length === 0 && (
              <div className={styles.emptyNote}>No eval runs yet.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create CSS module**

Create `client/src/components/Quality/QualityTab.module.css`:

```css
.container {
  padding: 16px;
  overflow-y: auto;
  height: 100%;
}

.header {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 16px;
}

.runButton {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--accent, #c45a20);
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.runButton:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.section {
  border: 1px solid var(--border, rgba(0,0,0,0.1));
  border-radius: 12px;
  margin-bottom: 12px;
  overflow: hidden;
}

.sectionHeader {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--bg-secondary, rgba(0,0,0,0.03));
  cursor: pointer;
  user-select: none;
}

.sectionTitle {
  font-weight: 600;
  font-size: 14px;
}

.badge {
  font-size: 12px;
  opacity: 0.5;
  background: var(--bg-tertiary, rgba(0,0,0,0.06));
  padding: 2px 8px;
  border-radius: 10px;
  margin-left: auto;
}

.sectionContent {
  padding: 8px 16px;
}

.folderCard {
  border-bottom: 1px solid var(--border, rgba(0,0,0,0.06));
  padding: 10px 0;
}

.folderCard:last-child {
  border-bottom: none;
}

.folderHeader {
  display: flex;
  align-items: center;
  gap: 10px;
}

.toggle {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary, rgba(0,0,0,0.4));
  padding: 0;
}

.toggleOn {
  color: var(--accent, #c45a20);
}

.folderInfo {
  cursor: pointer;
  flex: 1;
}

.folderName {
  font-weight: 600;
  font-size: 14px;
}

.disarmed {
  opacity: 0.5;
}

.evalCount {
  font-size: 12px;
  opacity: 0.5;
  margin-left: 8px;
}

.folderControls {
  display: flex;
  align-items: center;
  gap: 6px;
}

.triggerPill {
  font-size: 11px;
  background: var(--accent-light, rgba(196,90,32,0.1));
  color: var(--accent, #c45a20);
  padding: 2px 8px;
  border-radius: 6px;
}

.autoSendBtn {
  font-size: 11px;
  background: var(--bg-tertiary, rgba(0,0,0,0.05));
  color: var(--text-secondary, rgba(0,0,0,0.4));
  padding: 2px 8px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
}

.autoSendOn {
  background: var(--accent-light, rgba(196,90,32,0.1));
  color: var(--accent, #c45a20);
}

.evalList {
  padding: 8px 0 0 48px;
}

.evalRow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}

.evidenceType {
  font-size: 11px;
  opacity: 0.4;
  min-width: 60px;
}

.evalName {
  font-weight: 500;
}

.evalDesc {
  opacity: 0.5;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ruleRow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 13px;
}

.ruleName {
  flex: 1;
}

.severityBadge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
}

.severityBadge[data-severity="high"] {
  background: rgba(220, 53, 69, 0.1);
  color: #dc3545;
}

.severityBadge[data-severity="medium"] {
  background: rgba(255, 193, 7, 0.15);
  color: #b8860b;
}

.severityBadge[data-severity="low"] {
  background: rgba(0, 0, 0, 0.05);
  color: var(--text-secondary);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.stateDot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.pass {
  background: #22a867;
  color: #22a867;
}

.fail {
  background: #dc3545;
  color: #dc3545;
}

.error {
  background: #999;
  color: #999;
}

.disabled {
  background: var(--text-secondary, rgba(0,0,0,0.2));
}

.batchRow {
  border-bottom: 1px solid var(--border, rgba(0,0,0,0.06));
  padding: 8px 0;
}

.batchRow:last-child {
  border-bottom: none;
}

.batchHeader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  font-size: 13px;
}

.batchLabel {
  opacity: 0.7;
}

.batchSummary {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

.batchRuns {
  padding: 8px 0 0 16px;
}

.runRow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}

.runName {
  font-weight: 500;
}

.runFolder {
  opacity: 0.4;
  font-size: 12px;
}

.confidence {
  font-size: 11px;
  opacity: 0.5;
}

.empty {
  padding: 40px 20px;
  text-align: center;
  opacity: 0.5;
  font-size: 14px;
}

.emptyNote {
  padding: 12px 0;
  opacity: 0.5;
  font-size: 13px;
}
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Quality/QualityTab.jsx client/src/components/Quality/QualityTab.module.css client/src/components/Layout/Layout.jsx
git commit -m "feat: add Quality tab with eval folders, arming, and run history UI"
```

---

### Task 16: Integration test for Quality tab

**Files:**
- Create: `client/src/components/Quality/__tests__/QualityTab.integration.test.jsx`

- [ ] **Step 1: Write integration test**

Create `client/src/components/Quality/__tests__/QualityTab.integration.test.jsx`:

```jsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockApi = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
};
vi.mock('../../../utils/api', () => ({ api: mockApi }));

vi.mock('lucide-react', () => ({
  ChevronDown: (props) => React.createElement('span', { 'data-testid': 'chevron-down', ...props }),
  ChevronRight: (props) => React.createElement('span', { 'data-testid': 'chevron-right', ...props }),
  Play: (props) => React.createElement('span', { 'data-testid': 'play', ...props }),
  Shield: (props) => React.createElement('span', { 'data-testid': 'shield', ...props }),
  FlaskConical: (props) => React.createElement('span', { 'data-testid': 'flask', ...props }),
  ToggleLeft: (props) => React.createElement('span', { 'data-testid': 'toggle-left', ...props }),
  ToggleRight: (props) => React.createElement('span', { 'data-testid': 'toggle-right', ...props }),
}));

vi.mock('../QualityTab.module.css', () => ({ default: {} }));

import QualityTab from '../QualityTab';

describe('QualityTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no project linked', async () => {
    mockApi.get.mockResolvedValue(null);
    
    render(<QualityTab sessionId="test-123" session={{}} />);
    
    await waitFor(() => {
      expect(screen.getByText(/No project linked/)).toBeInTheDocument();
    });
  });

  it('renders eval folders when project exists', async () => {
    mockApi.get.mockImplementation((url) => {
      if (url.includes('/projects/by-session/')) return Promise.resolve({ id: 'proj-1', name: 'test' });
      if (url.includes('/evals/folders/')) return Promise.resolve([
        { name: 'event-onboarding', path: 'evals/event-onboarding', evalCount: 3, armed: true, triggers: 'session_end', autoSend: true, evals: [] },
        { name: 'recipes', path: 'evals/recipes', evalCount: 2, armed: false, triggers: 'manual', autoSend: false, evals: [] },
      ]);
      if (url.includes('/evals/history/')) return Promise.resolve([]);
      if (url.includes('/quality/rules')) return Promise.resolve([]);
      return Promise.resolve(null);
    });
    
    render(<QualityTab sessionId="test-123" session={{}} />);
    
    await waitFor(() => {
      expect(screen.getByText('event-onboarding')).toBeInTheDocument();
      expect(screen.getByText('recipes')).toBeInTheDocument();
    });
  });

  it('shows Run Armed Evals button', async () => {
    mockApi.get.mockImplementation((url) => {
      if (url.includes('/projects/by-session/')) return Promise.resolve({ id: 'proj-1', name: 'test' });
      if (url.includes('/evals/folders/')) return Promise.resolve([]);
      if (url.includes('/evals/history/')) return Promise.resolve([]);
      if (url.includes('/quality/rules')) return Promise.resolve([]);
      return Promise.resolve(null);
    });
    
    render(<QualityTab sessionId="test-123" session={{}} />);
    
    await waitFor(() => {
      expect(screen.getByText('Run Armed Evals')).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run client/src/components/Quality/__tests__/QualityTab.integration.test.jsx`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add client/src/components/Quality/__tests__/QualityTab.integration.test.jsx
git commit -m "test: add integration tests for QualityTab component"
```

---

### Task 17: Start dev server and verify

**Files:** None (verification only)

- [ ] **Step 1: Check .env for PORT**

Read `.env` and find PORT value.

- [ ] **Step 2: Start dev server**

Run: `npm run dev` (or the project's dev command from package.json)

- [ ] **Step 3: Open in browser and verify**

Navigate to a session view and check that:
1. Quality tab appears in the tab bar
2. Empty state shows correctly for sessions without a project
3. No console errors

- [ ] **Step 4: Run full test suite one final time**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Final commit if any fixes needed**

Only if verification revealed issues that need fixing.

---

## Summary

| Phase | Tasks | What it delivers |
|-------|-------|-----------------|
| 1: Foundation | Tasks 1-5 | Project entity in DB, .mission-control.yaml discovery, session-project linking |
| 2: Evals Engine | Tasks 6-10 | YAML eval loader, check runner, evidence gatherers, LLM judge, eval pipeline |
| 3: Storage & Orchestration | Tasks 11-14 | DB tables for runs, API routes, failure message composer, session end trigger |
| 4: UI | Tasks 15-17 | Quality tab with eval folders, arming controls, run history, integration tests |
