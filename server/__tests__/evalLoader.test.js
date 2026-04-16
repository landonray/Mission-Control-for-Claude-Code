import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockYamlLoad = vi.fn();

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

vi.mock('js-yaml', () => ({
  load: mockYamlLoad,
  default: { load: mockYamlLoad },
}));

describe('evalLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function getModule() {
    return await import('../services/evalLoader.js');
  }

  describe('loadEval', () => {
    it('loads and validates a valid eval file with checks', async () => {
      mockReadFileSync.mockReturnValue('yaml-content');
      mockYamlLoad.mockReturnValue({
        name: 'test-eval',
        description: 'A test eval',
        input: { prompt: 'test prompt' },
        evidence: { type: 'log_query', source: 'stdout' },
        checks: [{ type: 'not_empty' }],
      });

      const { loadEval } = await getModule();
      const result = loadEval('/path/to/eval.yaml');

      expect(result.name).toBe('test-eval');
      expect(result._source).toBe('/path/to/eval.yaml');
    });

    it('loads a valid eval with judge_prompt and expected', async () => {
      mockReadFileSync.mockReturnValue('yaml-content');
      mockYamlLoad.mockReturnValue({
        name: 'judge-eval',
        description: 'A judge eval',
        input: {},
        evidence: { type: 'file', path: 'output.txt' },
        judge_prompt: 'Did it work?',
        expected: 'Yes it worked',
      });

      const { loadEval } = await getModule();
      const result = loadEval('/path/to/eval.yaml');
      expect(result.name).toBe('judge-eval');
    });

    it('throws when name is missing', async () => {
      mockReadFileSync.mockReturnValue('yaml');
      mockYamlLoad.mockReturnValue({
        description: 'Missing name',
        evidence: { type: 'file' },
        checks: [{ type: 'not_empty' }],
      });

      const { loadEval } = await getModule();
      expect(() => loadEval('/eval.yaml')).toThrow('missing required field "name"');
    });

    it('throws when description is missing', async () => {
      mockReadFileSync.mockReturnValue('yaml');
      mockYamlLoad.mockReturnValue({
        name: 'test',
        evidence: { type: 'file' },
        checks: [{ type: 'not_empty' }],
      });

      const { loadEval } = await getModule();
      expect(() => loadEval('/eval.yaml')).toThrow('missing required field "description"');
    });

    it('throws when evidence is missing', async () => {
      mockReadFileSync.mockReturnValue('yaml');
      mockYamlLoad.mockReturnValue({
        name: 'test',
        description: 'desc',
        checks: [{ type: 'not_empty' }],
      });

      const { loadEval } = await getModule();
      expect(() => loadEval('/eval.yaml')).toThrow('missing required field "evidence"');
    });

    it('throws when input is missing', async () => {
      mockReadFileSync.mockReturnValue('yaml');
      mockYamlLoad.mockReturnValue({
        name: 'test',
        description: 'desc',
        evidence: { type: 'file' },
        checks: [{ type: 'not_empty' }],
      });

      const { loadEval } = await getModule();
      expect(() => loadEval('/eval.yaml')).toThrow('missing or invalid "input" field');
    });

    it('throws when input is an array instead of a map', async () => {
      mockReadFileSync.mockReturnValue('yaml');
      mockYamlLoad.mockReturnValue({
        name: 'test',
        description: 'desc',
        evidence: { type: 'file' },
        input: ['not', 'a', 'map'],
        checks: [{ type: 'not_empty' }],
      });

      const { loadEval } = await getModule();
      expect(() => loadEval('/eval.yaml')).toThrow('missing or invalid "input" field');
    });

    it('throws when neither checks nor judge_prompt is present', async () => {
      mockReadFileSync.mockReturnValue('yaml');
      mockYamlLoad.mockReturnValue({
        name: 'test',
        description: 'desc',
        input: {},
        evidence: { type: 'file' },
      });

      const { loadEval } = await getModule();
      expect(() => loadEval('/eval.yaml')).toThrow('must have at least one of');
    });

    it('throws when judge_prompt is present but expected is missing', async () => {
      mockReadFileSync.mockReturnValue('yaml');
      mockYamlLoad.mockReturnValue({
        name: 'test',
        description: 'desc',
        input: {},
        evidence: { type: 'file' },
        judge_prompt: 'Evaluate this',
      });

      const { loadEval } = await getModule();
      expect(() => loadEval('/eval.yaml')).toThrow('"expected" is required');
    });

    it('throws for invalid check type', async () => {
      mockReadFileSync.mockReturnValue('yaml');
      mockYamlLoad.mockReturnValue({
        name: 'test',
        description: 'desc',
        input: {},
        evidence: { type: 'file' },
        checks: [{ type: 'bogus_check' }],
      });

      const { loadEval } = await getModule();
      expect(() => loadEval('/eval.yaml')).toThrow('invalid check type "bogus_check"');
    });

    it('throws for invalid evidence type', async () => {
      mockReadFileSync.mockReturnValue('yaml');
      mockYamlLoad.mockReturnValue({
        name: 'test',
        description: 'desc',
        input: {},
        evidence: { type: 'magic_source' },
        checks: [{ type: 'not_empty' }],
      });

      const { loadEval } = await getModule();
      expect(() => loadEval('/eval.yaml')).toThrow('invalid evidence type "magic_source"');
    });

    it('throws when evidence.type is missing', async () => {
      mockReadFileSync.mockReturnValue('yaml');
      mockYamlLoad.mockReturnValue({
        name: 'test',
        description: 'desc',
        input: {},
        evidence: { source: 'stdout' },
        checks: [{ type: 'not_empty' }],
      });

      const { loadEval } = await getModule();
      expect(() => loadEval('/eval.yaml')).toThrow('missing required field "evidence.type"');
    });

    it('throws for invalid judge.model tier', async () => {
      mockReadFileSync.mockReturnValue('yaml');
      mockYamlLoad.mockReturnValue({
        name: 'test',
        description: 'desc',
        input: {},
        evidence: { type: 'file', path: 'out.txt' },
        judge_prompt: 'Check it',
        expected: 'works',
        judge: { model: 'claude-sonnet-4-6' },
      });

      const { loadEval } = await getModule();
      expect(() => loadEval('/eval.yaml')).toThrow('invalid judge model "claude-sonnet-4-6"');
    });

    it('accepts valid judge.model tier', async () => {
      mockReadFileSync.mockReturnValue('yaml');
      mockYamlLoad.mockReturnValue({
        name: 'test',
        description: 'desc',
        input: {},
        evidence: { type: 'file', path: 'out.txt' },
        judge_prompt: 'Check it',
        expected: 'works',
        judge: { model: 'strong' },
      });

      const { loadEval } = await getModule();
      const result = loadEval('/eval.yaml');
      expect(result.judge.model).toBe('strong');
    });

    it('throws for non-object YAML', async () => {
      mockReadFileSync.mockReturnValue('yaml');
      mockYamlLoad.mockReturnValue('just a string');

      const { loadEval } = await getModule();
      expect(() => loadEval('/eval.yaml')).toThrow('not a valid YAML object');
    });
  });

  describe('loadEvalFolder', () => {
    it('loads all yaml files from a folder', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(['a.yaml', 'b.yml', 'readme.md']);
      mockReadFileSync.mockReturnValue('yaml');

      const validEval = {
        name: 'test',
        description: 'desc',
        input: {},
        evidence: { type: 'file' },
        checks: [{ type: 'not_empty' }],
      };
      mockYamlLoad.mockReturnValue(validEval);

      const { loadEvalFolder } = await getModule();
      const results = loadEvalFolder('/evals');

      expect(results).toHaveLength(2);
      // Should not have loaded readme.md
      expect(mockReadFileSync).toHaveBeenCalledTimes(2);
    });

    it('returns empty array when folder does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const { loadEvalFolder } = await getModule();
      expect(loadEvalFolder('/nonexistent')).toEqual([]);
    });
  });

  describe('discoverEvalFolders', () => {
    it('uses config evals.folders when provided', async () => {
      const { discoverEvalFolders } = await getModule();
      const result = discoverEvalFolders('/project', {
        evals: { folders: ['tests/evals', 'custom/evals'] },
      });

      expect(result).toEqual([
        '/project/tests/evals',
        '/project/custom/evals',
      ]);
    });

    it('returns subfolders of evals/ when subfolders exist', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([
        { name: 'event-onboarding', isDirectory: () => true, isFile: () => false },
        { name: 'recipe-extraction', isDirectory: () => true, isFile: () => false },
        { name: 'readme.md', isDirectory: () => false, isFile: () => true },
      ]);

      const { discoverEvalFolders } = await getModule();
      const result = discoverEvalFolders('/project');

      expect(result).toEqual([
        '/project/evals/event-onboarding',
        '/project/evals/recipe-extraction',
      ]);
    });

    it('falls back to evals/ itself when it has YAML files but no subfolders', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([
        { name: 'test-eval.yaml', isDirectory: () => false, isFile: () => true },
      ]);

      const { discoverEvalFolders } = await getModule();
      const result = discoverEvalFolders('/project');

      expect(result).toEqual(['/project/evals']);
    });

    it('returns empty when evals/ exists but is empty', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([]);

      const { discoverEvalFolders } = await getModule();
      const result = discoverEvalFolders('/project');

      expect(result).toEqual([]);
    });

    it('returns empty when no config and no evals/ directory', async () => {
      mockExistsSync.mockReturnValue(false);

      const { discoverEvalFolders } = await getModule();
      const result = discoverEvalFolders('/project');

      expect(result).toEqual([]);
    });
  });

  describe('exports', () => {
    it('exports VALID_CHECK_TYPES', async () => {
      const { VALID_CHECK_TYPES } = await getModule();
      expect(VALID_CHECK_TYPES).toContain('regex_match');
      expect(VALID_CHECK_TYPES).toContain('not_empty');
      expect(VALID_CHECK_TYPES).toContain('json_valid');
      expect(VALID_CHECK_TYPES).toContain('json_schema');
      expect(VALID_CHECK_TYPES).toContain('http_status');
      expect(VALID_CHECK_TYPES).toContain('field_exists');
      expect(VALID_CHECK_TYPES.length).toBeGreaterThanOrEqual(6);
    });

    it('exports VALID_EVIDENCE_TYPES', async () => {
      const { VALID_EVIDENCE_TYPES } = await getModule();
      expect(VALID_EVIDENCE_TYPES).toContain('log_query');
      expect(VALID_EVIDENCE_TYPES).toContain('db_query');
      expect(VALID_EVIDENCE_TYPES).toContain('sub_agent');
      expect(VALID_EVIDENCE_TYPES).toContain('file');
      expect(VALID_EVIDENCE_TYPES).toHaveLength(4);
    });
  });
});
