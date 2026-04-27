import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const prCreator = require('../pipelinePrCreator');

describe('pipelinePrCreator', () => {
  let runGit, runGh;

  beforeEach(() => {
    runGit = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    runGh = vi.fn();
    prCreator._setExecutorsForTests({ runGit, runGh });
  });

  afterEach(() => {
    prCreator._resetExecutorsForTests();
  });

  it('pushes the branch and runs gh pr create, returning the URL', async () => {
    runGh.mockResolvedValueOnce({
      stdout: 'https://github.com/example/repo/pull/42\n',
      stderr: '',
    });

    const result = await prCreator.createPullRequest({
      projectRootPath: '/tmp/repo',
      branchName: 'pipeline-foo',
      pipelineName: 'Foo feature',
      pipelineId: 'pipe_abc',
      specInput: 'Build foo.',
    });

    expect(result).toEqual({
      url: 'https://github.com/example/repo/pull/42',
      existed: false,
    });
    expect(runGit).toHaveBeenCalledWith(
      ['push', '-u', 'origin', 'pipeline-foo'],
      { cwd: '/tmp/repo' }
    );
    const ghArgs = runGh.mock.calls[0][0];
    expect(ghArgs[0]).toBe('pr');
    expect(ghArgs[1]).toBe('create');
    expect(ghArgs).toContain('--head');
    expect(ghArgs).toContain('pipeline-foo');
    expect(ghArgs).toContain('--base');
    expect(ghArgs).toContain('main');
  });

  it('returns existing PR url when gh reports the PR already exists', async () => {
    const err = new Error('exit 1');
    err.stderr = 'a pull request for branch "pipeline-foo" already exists';
    runGh
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        stdout: 'https://github.com/example/repo/pull/7\n',
        stderr: '',
      });

    const result = await prCreator.createPullRequest({
      projectRootPath: '/tmp/repo',
      branchName: 'pipeline-foo',
      pipelineName: 'Foo',
      pipelineId: 'pipe_abc',
      specInput: 'Build foo.',
    });

    expect(result).toEqual({
      url: 'https://github.com/example/repo/pull/7',
      existed: true,
    });
  });

  it('throws a clean error message when gh fails for an unknown reason', async () => {
    const err = new Error('exit 1');
    err.stderr = 'gh: Not authenticated\nrun gh auth login';
    runGh.mockRejectedValueOnce(err);

    await expect(
      prCreator.createPullRequest({
        projectRootPath: '/tmp/repo',
        branchName: 'pipeline-foo',
        pipelineName: 'Foo',
        pipelineId: 'pipe_abc',
        specInput: 'Build foo.',
      })
    ).rejects.toThrow(/gh pr create failed: gh: Not authenticated/);
  });

  it('builds a PR body that includes the spec input and pipeline id', () => {
    const body = prCreator.buildPrBody({
      pipelineName: 'My pipeline',
      specInput: 'Add a thing.',
      pipelineId: 'pipe_xyz',
    });
    expect(body).toContain('pipe_xyz');
    expect(body).toContain('My pipeline');
    expect(body).toContain('Add a thing.');
  });
});
