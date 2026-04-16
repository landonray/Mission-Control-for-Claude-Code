import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockCliRun = vi.fn();

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

vi.mock('../services/cliAgent.js', () => ({
  run: mockCliRun,
  default: { run: mockCliRun },
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
    it('includes description, evidence types, check types, and folder listing', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(['existing-eval.yaml']);
      mockReadFileSync.mockReturnValue('name: existing-eval\ndescription: An existing eval');

      const { buildAuthoringPrompt } = await getModule();
      const prompt = buildAuthoringPrompt({
        description: 'Check that the login flow works',
        folderPath: '/project/evals/auth',
        projectRoot: '/project',
      });

      // Description included
      expect(prompt).toContain('Check that the login flow works');

      // Evidence types
      expect(prompt).toContain('log_query');
      expect(prompt).toContain('db_query');
      expect(prompt).toContain('sub_agent');
      expect(prompt).toContain('file');

      // Check types
      expect(prompt).toContain('regex_match');
      expect(prompt).toContain('not_empty');
      expect(prompt).toContain('json_valid');
      expect(prompt).toContain('json_schema');
      expect(prompt).toContain('http_status');
      expect(prompt).toContain('field_exists');
      expect(prompt).toContain('equals');
      expect(prompt).toContain('contains');
      expect(prompt).toContain('greater_than');
      expect(prompt).toContain('less_than');
      expect(prompt).toContain('numeric_score');

      // Folder listing shows existing eval
      expect(prompt).toContain('existing-eval.yaml');

      // Variable interpolation reference
      expect(prompt).toContain('${input.');
      expect(prompt).toContain('${project.root}');

      // Project root included
      expect(prompt).toContain('/project');

      // Instructions for output format
      expect(prompt).toContain('REASONING');
    });

    it('includes project config when missionControlConfig is provided', async () => {
      mockExistsSync.mockReturnValue(false);
      mockReaddirSync.mockReturnValue([]);

      const { buildAuthoringPrompt } = await getModule();
      const prompt = buildAuthoringPrompt({
        description: 'Test something',
        folderPath: '/project/evals/tests',
        projectRoot: '/project',
        missionControlConfig: {
          project: { name: 'My App' },
          evals: { folders: ['evals/tests'] },
        },
      });

      expect(prompt).toContain('My App');
    });

    it('includes refinement context when provided', async () => {
      mockExistsSync.mockReturnValue(false);
      mockReaddirSync.mockReturnValue([]);

      const { buildAuthoringPrompt } = await getModule();
      const prompt = buildAuthoringPrompt({
        description: 'Check that the login flow works',
        folderPath: '/project/evals/auth',
        projectRoot: '/project',
        refinement: 'Also check that the error message shows when password is wrong',
        currentFormState: {
          name: 'login-flow',
          description: 'Check that the login flow works',
        },
      });

      // Refinement text included
      expect(prompt).toContain('Also check that the error message shows when password is wrong');

      // Current form state included
      expect(prompt).toContain('login-flow');

      // Original description still present
      expect(prompt).toContain('Check that the login flow works');
    });

    it('includes existing eval content as style reference', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(['eval-one.yaml', 'eval-two.yaml', 'eval-three.yaml']);
      mockReadFileSync.mockReturnValue('name: sample-eval\ndescription: A sample eval for reference');

      const { buildAuthoringPrompt } = await getModule();
      const prompt = buildAuthoringPrompt({
        description: 'New eval',
        folderPath: '/project/evals/tests',
        projectRoot: '/project',
      });

      // Style reference content included (from up to 2 evals)
      expect(prompt).toContain('sample-eval');
      // Only reads up to 2 files for style reference
      expect(mockReadFileSync).toHaveBeenCalledTimes(2);
    });
  });

  describe('parseAuthoringOutput', () => {
    it('extracts eval and reasoning from valid output', async () => {
      const { parseAuthoringOutput } = await getModule();

      const output = `
I've analyzed the folder and created an eval for you.

\`\`\`json
{
  "name": "login-flow",
  "description": "Checks that login works correctly",
  "input": { "url": "https://example.com/login" },
  "evidence": { "type": "file", "path": "output.txt" },
  "checks": [{ "type": "not_empty" }]
}
\`\`\`

REASONING: This eval tests the login flow by checking that the output file is not empty after the login attempt completes.
      `;

      const result = parseAuthoringOutput(output);

      expect(result.error).toBeNull();
      expect(result.eval).not.toBeNull();
      expect(result.eval.name).toBe('login-flow');
      expect(result.eval.description).toBe('Checks that login works correctly');
      expect(result.reasoning).toContain('login flow');
    });

    it('returns error when output has no JSON code block', async () => {
      const { parseAuthoringOutput } = await getModule();

      const output = `
I looked at the folder but I'm not sure what eval to create.
Please give me more context about what you want to test.
      `;

      const result = parseAuthoringOutput(output);

      expect(result.eval).toBeNull();
      expect(result.reasoning).toBeNull();
      expect(result.error).toBeTruthy();
      expect(result.error).toContain('JSON');
    });

    it('returns error for invalid JSON in code block', async () => {
      const { parseAuthoringOutput } = await getModule();

      const output = `
Here is the eval:

\`\`\`json
{
  "name": "broken-eval",
  "description": "This JSON is not valid
  "input": {}
}
\`\`\`

REASONING: Some reasoning here.
      `;

      const result = parseAuthoringOutput(output);

      expect(result.eval).toBeNull();
      expect(result.reasoning).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });

  describe('runAuthoring', () => {
    it('returns parsed eval on successful CLI run', async () => {
      mockExistsSync.mockReturnValue(false);
      mockReaddirSync.mockReturnValue([]);

      const validOutput = `
\`\`\`json
{
  "name": "my-eval",
  "description": "Test something",
  "input": {},
  "evidence": { "type": "file", "path": "output.txt" },
  "checks": [{ "type": "not_empty" }]
}
\`\`\`

REASONING: Created a basic eval that checks the output file.
      `;

      mockCliRun.mockResolvedValue(validOutput);

      const { runAuthoring } = await getModule();
      const result = await runAuthoring({
        description: 'Test something',
        folderPath: '/project/evals/tests',
        projectRoot: '/project',
      });

      expect(result.error).toBeFalsy();
      expect(result.eval).not.toBeNull();
      expect(result.eval.name).toBe('my-eval');
      expect(mockCliRun).toHaveBeenCalledOnce();

      // Verify correct tools were passed
      const [, options] = mockCliRun.mock.calls[0];
      expect(options.allowedTools).toContain('Read');
      expect(options.allowedTools).toContain('Glob');
      expect(options.allowedTools).toContain('Grep');
      expect(options.cwd).toBe('/project');
      expect(options.timeout).toBe(180000);
    });

    it('returns error when CLI agent fails', async () => {
      mockExistsSync.mockReturnValue(false);
      mockReaddirSync.mockReturnValue([]);

      mockCliRun.mockRejectedValue(new Error('CLI agent failed: timeout'));

      const { runAuthoring } = await getModule();
      const result = await runAuthoring({
        description: 'Test something',
        folderPath: '/project/evals/tests',
        projectRoot: '/project',
      });

      expect(result.eval).toBeNull();
      expect(result.error).toBeTruthy();
      expect(result.error).toContain('CLI agent failed');
    });
  });
});
