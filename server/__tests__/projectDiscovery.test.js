import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockYamlLoad = vi.fn();
const mockQuery = vi.fn();
const mockUuidV4 = vi.fn(() => 'test-uuid-1234');

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  default: { existsSync: mockExistsSync, readFileSync: mockReadFileSync },
}));

vi.mock('js-yaml', () => ({
  load: mockYamlLoad,
  default: { load: mockYamlLoad },
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

  it('returns null when no .mission-control.yaml is found', async () => {
    mockExistsSync.mockReturnValue(false);
    const { resolveProject } = await import('../services/projectDiscovery.js');
    expect(await resolveProject('/projects/no-config')).toBeNull();
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
      'SELECT * FROM projects WHERE root_path = $1',
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
      'UPDATE projects SET settings = $1 WHERE id = $2 RETURNING *',
      [JSON.stringify({ theme: 'dark' }), 'proj-1']
    );
  });

  it('returns null when project is not found', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const { updateProjectSettings } = await import('../services/projectDiscovery.js');
    expect(await updateProjectSettings('nonexistent', {})).toBeNull();
  });
});
