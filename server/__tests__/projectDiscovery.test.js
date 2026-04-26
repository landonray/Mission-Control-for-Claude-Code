import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockYamlLoad = vi.fn();
const mockYamlDump = vi.fn(() => 'project: {}\nevals:\n  folders: []\nquality_rules:\n  enabled: []\n  disabled: []\n');
const mockQuery = vi.fn();
const mockUuidV4 = vi.fn(() => 'test-uuid-1234');

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  default: { existsSync: mockExistsSync, readFileSync: mockReadFileSync, writeFileSync: mockWriteFileSync },
}));

vi.mock('js-yaml', () => ({
  load: mockYamlLoad,
  dump: mockYamlDump,
  default: { load: mockYamlLoad, dump: mockYamlDump },
}));

vi.mock('uuid', () => ({
  v4: mockUuidV4,
}));

vi.mock('../database.js', () => ({
  query: mockQuery,
}));

describe('findProjectRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns the directory when .mission-control.yaml is found in startDir', async () => {
    mockExistsSync.mockImplementation((p) =>
      p === '/projects/my-app/.mission-control.yaml'
    );
    const { findProjectRoot } = await import('../services/projectDiscovery.js');
    expect(findProjectRoot('/projects/my-app')).toBe('/projects/my-app');
  });

  it('walks up the tree and finds config in a parent directory', async () => {
    mockExistsSync.mockImplementation((p) =>
      p === '/projects/my-app/.mission-control.yaml'
    );
    const { findProjectRoot } = await import('../services/projectDiscovery.js');
    expect(findProjectRoot('/projects/my-app/src/components')).toBe('/projects/my-app');
  });

  it('returns null when no config file is found up to root', async () => {
    mockExistsSync.mockReturnValue(false);
    const { findProjectRoot } = await import('../services/projectDiscovery.js');
    expect(findProjectRoot('/projects/my-app')).toBeNull();
  });

  it('handles the filesystem root without infinite loop', async () => {
    mockExistsSync.mockReturnValue(false);
    const { findProjectRoot } = await import('../services/projectDiscovery.js');
    expect(findProjectRoot('/')).toBeNull();
  });
});

describe('loadProjectConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('parses a full .mission-control.yaml and returns structured config', async () => {
    mockReadFileSync.mockReturnValue('test yaml');
    mockYamlLoad.mockReturnValue({
      project: { name: 'My App' },
      evals: { folders: ['evals/'] },
      quality_rules: { enabled: ['rule1'], disabled: ['rule2'] },
    });

    const { loadProjectConfig } = await import('../services/projectDiscovery.js');
    const config = loadProjectConfig('/projects/my-app');
    expect(mockReadFileSync).toHaveBeenCalledWith(
      '/projects/my-app/.mission-control.yaml',
      'utf8'
    );
    expect(config.project.name).toBe('My App');
    expect(config.evals.folders).toEqual(['evals/']);
    expect(config.quality_rules.enabled).toEqual(['rule1']);
    expect(config.quality_rules.disabled).toEqual(['rule2']);
  });

  it('returns defaults for missing fields', async () => {
    mockReadFileSync.mockReturnValue('');
    mockYamlLoad.mockReturnValue({ project: { name: 'Partial' } });

    const { loadProjectConfig } = await import('../services/projectDiscovery.js');
    const config = loadProjectConfig('/projects/partial');
    expect(config.project.name).toBe('Partial');
    expect(config.evals.folders).toEqual([]);
    expect(config.quality_rules.enabled).toEqual([]);
    expect(config.quality_rules.disabled).toEqual([]);
  });

  it('returns full defaults when file does not exist', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const { loadProjectConfig } = await import('../services/projectDiscovery.js');
    const config = loadProjectConfig('/nonexistent');
    expect(config.project).toEqual({});
    expect(config.evals.folders).toEqual([]);
    expect(config.quality_rules.enabled).toEqual([]);
  });

  it('returns full defaults when yaml.load returns null', async () => {
    mockReadFileSync.mockReturnValue('');
    mockYamlLoad.mockReturnValue(null);

    const { loadProjectConfig } = await import('../services/projectDiscovery.js');
    const config = loadProjectConfig('/projects/empty');
    expect(config.project).toEqual({});
    expect(config.evals.folders).toEqual([]);
  });
});

describe('resolveProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns null when workingDirectory is falsy', async () => {
    const { resolveProject } = await import('../services/projectDiscovery.js');
    expect(await resolveProject(null)).toBeNull();
    expect(await resolveProject('')).toBeNull();
  });

  it('returns null when no .mission-control.yaml and no git root is found', async () => {
    mockExistsSync.mockReturnValue(false);
    const { resolveProject } = await import('../services/projectDiscovery.js');
    expect(await resolveProject('/projects/no-config')).toBeNull();
  });

  it('auto-creates .mission-control.yaml when git root exists but no yaml', async () => {
    // No .mission-control.yaml anywhere, but .git exists at /projects/git-app
    mockExistsSync.mockImplementation((p) => {
      if (p === '/projects/git-app/.git') return true;
      if (p.endsWith('.mission-control.yaml')) return false;
      return false;
    });
    mockReadFileSync.mockReturnValue('');
    mockYamlLoad.mockReturnValue({});
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'test-uuid-1234', name: 'git-app', root_path: '/projects/git-app' }],
    });

    const { resolveProject } = await import('../services/projectDiscovery.js');
    const project = await resolveProject('/projects/git-app');
    expect(project).not.toBeNull();
    expect(project.id).toBe('test-uuid-1234');
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/projects/git-app/.mission-control.yaml',
      expect.any(String),
      'utf8'
    );
  });

  it('returns existing project from DB when root_path matches', async () => {
    mockExistsSync.mockImplementation((p) =>
      p === '/projects/my-app/.mission-control.yaml'
    );
    mockReadFileSync.mockReturnValue('');
    mockYamlLoad.mockReturnValue({ project: { name: 'My App' } });
    mockQuery.mockResolvedValue({
      rows: [{ id: 'existing-id', name: 'My App', root_path: '/projects/my-app' }],
    });

    const { resolveProject } = await import('../services/projectDiscovery.js');
    const project = await resolveProject('/projects/my-app');
    expect(project.id).toBe('existing-id');
    expect(project.config).toBeDefined();
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM projects WHERE LOWER(root_path) = LOWER($1)',
      ['/projects/my-app']
    );
  });

  it('creates a new project in DB when none exists for root_path', async () => {
    mockExistsSync.mockImplementation((p) =>
      p === '/projects/new-app/.mission-control.yaml'
    );
    mockReadFileSync.mockReturnValue('');
    mockYamlLoad.mockReturnValue({ project: { name: 'New App' } });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'test-uuid-1234', name: 'New App', root_path: '/projects/new-app' }],
    });

    const { resolveProject } = await import('../services/projectDiscovery.js');
    const project = await resolveProject('/projects/new-app');
    expect(project.id).toBe('test-uuid-1234');
    expect(project.name).toBe('New App');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('uses directory basename when config has no project name', async () => {
    mockExistsSync.mockImplementation((p) =>
      p === '/projects/my-app/.mission-control.yaml'
    );
    mockReadFileSync.mockReturnValue('');
    mockYamlLoad.mockReturnValue({});
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'test-uuid-1234', name: 'my-app', root_path: '/projects/my-app' }],
    });

    const { resolveProject } = await import('../services/projectDiscovery.js');
    await resolveProject('/projects/my-app');
    expect(mockQuery.mock.calls[1][1][1]).toBe('my-app');
  });
});

describe('findGitRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns the directory containing .git', async () => {
    mockExistsSync.mockImplementation((p) => p === '/projects/my-app/.git');
    const { findGitRoot } = await import('../services/projectDiscovery.js');
    expect(findGitRoot('/projects/my-app/src')).toBe('/projects/my-app');
  });

  it('returns null when no .git is found up to root', async () => {
    mockExistsSync.mockReturnValue(false);
    const { findGitRoot } = await import('../services/projectDiscovery.js');
    expect(findGitRoot('/projects/no-git')).toBeNull();
  });
});

describe('createDefaultConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('writes default config yaml to disk', async () => {
    mockExistsSync.mockReturnValue(false);
    const { createDefaultConfig } = await import('../services/projectDiscovery.js');
    const result = createDefaultConfig('/projects/my-app');
    expect(result).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/projects/my-app/.mission-control.yaml',
      expect.any(String),
      'utf8'
    );
  });

  it('returns false if file already exists', async () => {
    mockExistsSync.mockImplementation((p) =>
      p === '/projects/my-app/.mission-control.yaml'
    );
    const { createDefaultConfig } = await import('../services/projectDiscovery.js');
    const result = createDefaultConfig('/projects/my-app');
    expect(result).toBe(false);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('returns false and logs warning on write failure', async () => {
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => { throw new Error('EACCES'); });
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createDefaultConfig } = await import('../services/projectDiscovery.js');
    const result = createDefaultConfig('/projects/readonly');
    expect(result).toBe(false);
    spy.mockRestore();
  });
});

describe('getProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns null when project is not found', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const { getProject } = await import('../services/projectDiscovery.js');
    expect(await getProject('nonexistent')).toBeNull();
  });

  it('returns project with config attached from disk', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'proj-1', name: 'Test', root_path: '/projects/test' }],
    });
    mockReadFileSync.mockReturnValue('');
    mockYamlLoad.mockReturnValue({ project: { name: 'Test' } });

    const { getProject } = await import('../services/projectDiscovery.js');
    const project = await getProject('proj-1');
    expect(project.id).toBe('proj-1');
    expect(project.config).toBeDefined();
    expect(project.config.project.name).toBe('Test');
  });

  it('attaches default config when disk read fails', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'proj-1', name: 'Test', root_path: '/nonexistent' }],
    });
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const { getProject } = await import('../services/projectDiscovery.js');
    const project = await getProject('proj-1');
    expect(project.config.project).toEqual({});
    expect(project.config.evals.folders).toEqual([]);
  });
});

describe('matchProjectByPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('matches when working_directory equals a project root_path', async () => {
    const { matchProjectByPath } = await import('../services/projectDiscovery.js');
    const projects = [{ id: 'proj-1', root_path: '/projects/my-app' }];
    expect(matchProjectByPath('/projects/my-app', projects)).toBe('proj-1');
  });

  it('matches a worktree path beneath a project root', async () => {
    const { matchProjectByPath } = await import('../services/projectDiscovery.js');
    const projects = [{ id: 'proj-1', root_path: '/projects/my-app' }];
    expect(
      matchProjectByPath('/projects/my-app/.claude/worktrees/foo', projects)
    ).toBe('proj-1');
  });

  it('matches case-insensitively', async () => {
    const { matchProjectByPath } = await import('../services/projectDiscovery.js');
    const projects = [{ id: 'proj-1', root_path: '/users/me/coding projects/Command Center' }];
    expect(
      matchProjectByPath('/Users/Me/Coding Projects/Command Center', projects)
    ).toBe('proj-1');
  });

  it('does not match a sibling whose name shares a prefix', async () => {
    const { matchProjectByPath } = await import('../services/projectDiscovery.js');
    const projects = [{ id: 'proj-1', root_path: '/projects/my-app' }];
    // /projects/my-app-other is NOT inside /projects/my-app
    expect(matchProjectByPath('/projects/my-app-other', projects)).toBeNull();
  });

  it('picks the deepest (longest) matching root when projects nest', async () => {
    const { matchProjectByPath } = await import('../services/projectDiscovery.js');
    const projects = [
      { id: 'outer', root_path: '/projects' },
      { id: 'inner', root_path: '/projects/my-app' },
    ];
    expect(matchProjectByPath('/projects/my-app/src', projects)).toBe('inner');
  });

  it('returns null when nothing matches', async () => {
    const { matchProjectByPath } = await import('../services/projectDiscovery.js');
    const projects = [{ id: 'proj-1', root_path: '/projects/my-app' }];
    expect(matchProjectByPath('/somewhere/else', projects)).toBeNull();
  });

  it('returns null for empty inputs', async () => {
    const { matchProjectByPath } = await import('../services/projectDiscovery.js');
    expect(matchProjectByPath(null, [{ id: 'p', root_path: '/x' }])).toBeNull();
    expect(matchProjectByPath('/x', [])).toBeNull();
  });

  it('skips project records that have no root_path', async () => {
    const { matchProjectByPath } = await import('../services/projectDiscovery.js');
    const projects = [
      { id: 'broken', root_path: null },
      { id: 'good', root_path: '/projects/my-app' },
    ];
    expect(matchProjectByPath('/projects/my-app', projects)).toBe('good');
  });
});

describe('backfillSessionProjectIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns zero counts when no projects exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // SELECT projects
    const { backfillSessionProjectIds } = await import('../services/projectDiscovery.js');
    const result = await backfillSessionProjectIds();
    expect(result).toEqual({ scanned: 0, updated: 0, unmatched: 0 });
    // Should not even query for orphan sessions if there are no projects.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('updates orphan sessions whose working_directory falls under a project', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'proj-1', root_path: '/projects/my-app' }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'sess-1', working_directory: '/projects/my-app' },
        { id: 'sess-2', working_directory: '/projects/my-app/.claude/worktrees/foo' },
      ],
    });
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    const { backfillSessionProjectIds } = await import('../services/projectDiscovery.js');
    const result = await backfillSessionProjectIds();

    expect(result.updated).toBe(2);
    expect(result.unmatched).toBe(0);
    // First two calls are SELECTs; remaining are UPDATEs.
    const updateCalls = mockQuery.mock.calls.slice(2);
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0][0]).toMatch(/^UPDATE sessions SET project_id/);
    expect(updateCalls[0][1]).toEqual(['proj-1', 'sess-1']);
    expect(updateCalls[1][1]).toEqual(['proj-1', 'sess-2']);
  });

  it('counts but does not update sessions whose path matches no project', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'proj-1', root_path: '/projects/my-app' }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'sess-orphan', working_directory: '/somewhere/else' }],
    });

    const { backfillSessionProjectIds } = await import('../services/projectDiscovery.js');
    const result = await backfillSessionProjectIds();

    expect(result.updated).toBe(0);
    expect(result.unmatched).toBe(1);
    // No UPDATE issued for the unmatched orphan.
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('matches case-insensitive paths (the macOS path-case bug)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'cc', root_path: '/users/me/coding projects/Command Center' }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 's1', working_directory: '/Users/Me/Coding Projects/Command Center' },
      ],
    });
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    const { backfillSessionProjectIds } = await import('../services/projectDiscovery.js');
    const result = await backfillSessionProjectIds();

    expect(result.updated).toBe(1);
    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[1]).toEqual(['cc', 's1']);
  });
});

describe('updateProjectSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('updates settings and returns project with config', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 'proj-1', name: 'Test', root_path: '/projects/test', settings: { theme: 'dark' } }],
    });
    mockReadFileSync.mockReturnValue('');
    mockYamlLoad.mockReturnValue({});

    const { updateProjectSettings } = await import('../services/projectDiscovery.js');
    const project = await updateProjectSettings('proj-1', { theme: 'dark' });
    expect(project.settings).toEqual({ theme: 'dark' });
    expect(mockQuery).toHaveBeenCalledWith(
      "UPDATE projects SET settings = COALESCE(settings, '{}'::jsonb) || $1::jsonb WHERE id = $2 RETURNING *",
      [JSON.stringify({ theme: 'dark' }), 'proj-1']
    );
  });

  it('returns null when project is not found', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const { updateProjectSettings } = await import('../services/projectDiscovery.js');
    expect(await updateProjectSettings('nonexistent', {})).toBeNull();
  });
});
