import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('child_process', () => ({ execSync: mockExecSync, execFileSync: mockExecFileSync, default: { execSync: mockExecSync, execFileSync: mockExecFileSync } }));
vi.mock('fs', () => ({ existsSync: mockExistsSync, default: { existsSync: mockExistsSync } }));

describe('getWorktreeStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns hasUncommittedChanges: true when git status has output', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue(' M src/file.js\n?? newfile.txt\n');

    const { getWorktreeStatus } = await import('../services/worktreeCleanup.js');
    const result = getWorktreeStatus('/path/to/.claude/worktrees/test-wt');

    expect(result).toEqual({
      hasUncommittedChanges: true,
      worktreePath: '/path/to/.claude/worktrees/test-wt',
    });
    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['status', '--porcelain'], {
      cwd: '/path/to/.claude/worktrees/test-wt',
      encoding: 'utf-8',
      timeout: 5000,
    });
  });

  it('returns hasUncommittedChanges: false when git status is clean', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue('');

    const { getWorktreeStatus } = await import('../services/worktreeCleanup.js');
    const result = getWorktreeStatus('/path/to/.claude/worktrees/test-wt');

    expect(result).toEqual({
      hasUncommittedChanges: false,
      worktreePath: '/path/to/.claude/worktrees/test-wt',
    });
  });

  it('returns hasUncommittedChanges: false when directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const { getWorktreeStatus } = await import('../services/worktreeCleanup.js');
    const result = getWorktreeStatus('/path/to/.claude/worktrees/gone');

    expect(result).toEqual({
      hasUncommittedChanges: false,
      worktreePath: '/path/to/.claude/worktrees/gone',
    });
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns hasUncommittedChanges: false when path is not a worktree', async () => {
    mockExistsSync.mockReturnValue(true);

    const { getWorktreeStatus } = await import('../services/worktreeCleanup.js');
    const result = getWorktreeStatus('/some/random/directory');

    expect(result).toEqual({
      hasUncommittedChanges: false,
      worktreePath: '/some/random/directory',
    });
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns hasUncommittedChanges: false when git status throws', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo'); });

    const { getWorktreeStatus } = await import('../services/worktreeCleanup.js');
    const result = getWorktreeStatus('/path/to/.claude/worktrees/broken');

    expect(result).toEqual({
      hasUncommittedChanges: false,
      worktreePath: '/path/to/.claude/worktrees/broken',
    });
  });
});

describe('commitWorktreeChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('stages all files and commits with WIP message', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue('');

    const { commitWorktreeChanges } = await import('../services/worktreeCleanup.js');
    commitWorktreeChanges('/path/to/.claude/worktrees/test-wt');

    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['add', '-A'], expect.objectContaining({
      cwd: '/path/to/.claude/worktrees/test-wt',
    }));
    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['commit', '-m', expect.stringContaining('WIP: session work from')], expect.objectContaining({
      cwd: '/path/to/.claude/worktrees/test-wt',
    }));
  });

  it('does nothing if directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const { commitWorktreeChanges } = await import('../services/worktreeCleanup.js');
    commitWorktreeChanges('/path/to/.claude/worktrees/gone');

    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('does nothing if path is not a worktree', async () => {
    mockExistsSync.mockReturnValue(true);

    const { commitWorktreeChanges } = await import('../services/worktreeCleanup.js');
    commitWorktreeChanges('/some/random/path');

    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

describe('cleanupWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('removes worktree and deletes branch locally and remotely when deleteBranch is true', async () => {
    mockExecFileSync.mockReturnValue('');

    const { cleanupWorktree } = await import('../services/worktreeCleanup.js');
    cleanupWorktree('/project/.claude/worktrees/test-wt', 'worktree-test-wt', '/project', true);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['worktree', 'remove', '--force', '/project/.claude/worktrees/test-wt'],
      expect.objectContaining({ cwd: '/project' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['branch', '-D', 'worktree-test-wt'],
      expect.objectContaining({ cwd: '/project' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['push', 'origin', '--delete', 'worktree-test-wt'],
      expect.objectContaining({ cwd: '/project' }),
    );
  });

  it('removes worktree but keeps branch when deleteBranch is false', async () => {
    mockExecFileSync.mockReturnValue('');

    const { cleanupWorktree } = await import('../services/worktreeCleanup.js');
    cleanupWorktree('/project/.claude/worktrees/test-wt', 'worktree-test-wt', '/project', false);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['worktree', 'remove', '--force', '/project/.claude/worktrees/test-wt'],
      expect.objectContaining({ cwd: '/project' }),
    );
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      'git', expect.arrayContaining(['branch', '-D']),
      expect.anything(),
    );
  });

  it('skips branch deletion when branchName is null', async () => {
    mockExecFileSync.mockReturnValue('');

    const { cleanupWorktree } = await import('../services/worktreeCleanup.js');
    cleanupWorktree('/project/.claude/worktrees/test-wt', null, '/project', true);

    expect(mockExecFileSync).toHaveBeenCalledTimes(1); // Only worktree remove
  });

  it('does not throw if worktree remove fails', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('already removed'); });

    const { cleanupWorktree } = await import('../services/worktreeCleanup.js');
    expect(() => {
      cleanupWorktree('/project/.claude/worktrees/test-wt', 'worktree-test-wt', '/project', true);
    }).not.toThrow();
  });
});

describe('checkBranchPR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns PR info when an open PR exists on the branch', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([
      { number: 42, title: 'Add feature X', url: 'https://github.com/user/repo/pull/42' }
    ]));

    const { checkBranchPR } = await import('../services/worktreeCleanup.js');
    const result = checkBranchPR('feature-branch', '/path/to/project');

    expect(result).toEqual({
      number: 42,
      title: 'Add feature X',
      url: 'https://github.com/user/repo/pull/42',
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'gh',
      ['pr', 'list', '--head', 'feature-branch', '--state', 'open', '--json', 'number,title,url'],
      expect.objectContaining({ cwd: '/path/to/project', timeout: 10000 }),
    );
  });

  it('returns null when no open PR exists', async () => {
    mockExecFileSync.mockReturnValue('[]');

    const { checkBranchPR } = await import('../services/worktreeCleanup.js');
    const result = checkBranchPR('feature-branch', '/path/to/project');

    expect(result).toBeNull();
  });

  it('returns null when gh command fails', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('gh not found'); });

    const { checkBranchPR } = await import('../services/worktreeCleanup.js');
    const result = checkBranchPR('no-gh-branch', '/path/to/project');

    expect(result).toBeNull();
  });

  it('returns null when branch name is falsy', async () => {
    const { checkBranchPR } = await import('../services/worktreeCleanup.js');
    const result = checkBranchPR(null, '/path/to/project');

    expect(result).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns null when projectRoot is falsy', async () => {
    const { checkBranchPR } = await import('../services/worktreeCleanup.js');
    const result = checkBranchPR('feature-branch', null);

    expect(result).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns first PR when multiple open PRs exist', async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([
      { number: 42, title: 'First PR', url: 'https://github.com/user/repo/pull/42' },
      { number: 43, title: 'Second PR', url: 'https://github.com/user/repo/pull/43' },
    ]));

    const { checkBranchPR } = await import('../services/worktreeCleanup.js');
    const result = checkBranchPR('feature-branch', '/path/to/project');

    expect(result).toEqual({
      number: 42,
      title: 'First PR',
      url: 'https://github.com/user/repo/pull/42',
    });
  });
});
