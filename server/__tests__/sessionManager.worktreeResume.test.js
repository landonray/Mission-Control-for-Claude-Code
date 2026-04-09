import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExistsSync = vi.fn();
const mockExecFileSync = vi.fn();
const mockQuery = vi.fn();

vi.mock('fs', () => ({ existsSync: mockExistsSync, default: { existsSync: mockExistsSync } }));
vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
  execSync: vi.fn(),
  spawn: vi.fn(),
  execFile: vi.fn(),
  default: { execFileSync: mockExecFileSync, execSync: vi.fn(), spawn: vi.fn(), execFile: vi.fn() },
}));

/**
 * Extract the resume worktree-recreation logic into a testable function.
 * This mirrors the logic that will replace lines 1596-1609 in sessionManager.js.
 */
async function resolveWorktreeOnResume(sessionRow, queryFn) {
  let workingDir = sessionRow.working_directory;

  if (!workingDir || mockExistsSync(workingDir)) {
    return workingDir; // Directory exists or no path — nothing to do
  }

  const worktreeMatch = workingDir.match(/^(.+?)\/\.claude\/worktrees\/([^/]+)/);
  if (!worktreeMatch) {
    return workingDir; // Not a worktree path — nothing to do
  }

  const parentDir = worktreeMatch[1];
  const worktreeName = sessionRow.worktree_name || worktreeMatch[2];
  const branchName = `worktree-${worktreeName}`;

  // Check if branch exists locally
  let branchExists = false;
  try {
    const localResult = mockExecFileSync('git', ['branch', '--list', branchName], {
      cwd: parentDir, encoding: 'utf-8', timeout: 5000,
    });
    branchExists = localResult.trim().length > 0;
  } catch { /* ignore */ }

  // If not local, check remote
  if (!branchExists) {
    try {
      const remoteResult = mockExecFileSync('git', ['branch', '-r', '--list', `origin/${branchName}`], {
        cwd: parentDir, encoding: 'utf-8', timeout: 5000,
      });
      branchExists = remoteResult.trim().length > 0;
    } catch { /* ignore */ }
  }

  if (branchExists) {
    // Recreate the worktree
    try {
      mockExecFileSync('git', ['worktree', 'add', `.claude/worktrees/${worktreeName}`, branchName], {
        cwd: parentDir, encoding: 'utf-8', timeout: 15000,
      });
      console.log(`[Session ${sessionRow.id.slice(0, 8)}] Recreated worktree at .claude/worktrees/${worktreeName} from branch ${branchName}`);
      return workingDir; // Original path is valid again — no DB change needed
    } catch (e) {
      console.error(`[Session ${sessionRow.id.slice(0, 8)}] Failed to recreate worktree:`, e.message);
    }
  }

  // Branch is gone (merged/deleted) — fall back to parent and update DB
  if (mockExistsSync(parentDir)) {
    console.log(`[Session ${sessionRow.id.slice(0, 8)}] Branch ${branchName} not found, falling back to project root: ${parentDir}`);
    await queryFn('UPDATE sessions SET working_directory = $1 WHERE id = $2', [parentDir, sessionRow.id]);
    return parentDir;
  }

  return workingDir; // Nothing we can do
}

describe('resolveWorktreeOnResume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rowCount: 1 });
  });

  it('returns existing directory unchanged', async () => {
    mockExistsSync.mockReturnValue(true);
    const result = await resolveWorktreeOnResume({
      id: 'test-id-1234',
      working_directory: '/project/.claude/worktrees/my-wt',
      worktree_name: 'my-wt',
    }, mockQuery);

    expect(result).toBe('/project/.claude/worktrees/my-wt');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('recreates worktree when directory is gone but branch exists locally', async () => {
    mockExistsSync.mockReturnValueOnce(false);
    mockExecFileSync
      .mockReturnValueOnce('  worktree-my-wt\n') // local branch check
      .mockReturnValueOnce(''); // git worktree add

    const result = await resolveWorktreeOnResume({
      id: 'test-id-1234',
      working_directory: '/project/.claude/worktrees/my-wt',
      worktree_name: 'my-wt',
    }, mockQuery);

    expect(result).toBe('/project/.claude/worktrees/my-wt');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['worktree', 'add', '.claude/worktrees/my-wt', 'worktree-my-wt'],
      expect.objectContaining({ cwd: '/project' })
    );
  });

  it('recreates worktree when branch exists only on remote', async () => {
    mockExistsSync.mockReturnValueOnce(false);
    mockExecFileSync
      .mockReturnValueOnce('') // local branch check — empty
      .mockReturnValueOnce('  remotes/origin/worktree-my-wt\n') // remote branch check
      .mockReturnValueOnce(''); // git worktree add

    const result = await resolveWorktreeOnResume({
      id: 'test-id-1234',
      working_directory: '/project/.claude/worktrees/my-wt',
      worktree_name: 'my-wt',
    }, mockQuery);

    expect(result).toBe('/project/.claude/worktrees/my-wt');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('falls back to parent dir and updates DB when branch is gone', async () => {
    mockExistsSync
      .mockReturnValueOnce(false) // worktree dir gone
      .mockReturnValueOnce(true); // parent dir exists
    mockExecFileSync
      .mockReturnValueOnce('') // local branch — empty
      .mockReturnValueOnce(''); // remote branch — empty

    const result = await resolveWorktreeOnResume({
      id: 'test-id-1234',
      working_directory: '/project/.claude/worktrees/my-wt',
      worktree_name: 'my-wt',
    }, mockQuery);

    expect(result).toBe('/project');
    expect(mockQuery).toHaveBeenCalledWith(
      'UPDATE sessions SET working_directory = $1 WHERE id = $2',
      ['/project', 'test-id-1234']
    );
  });

  it('uses worktree_name from DB when available instead of path extraction', async () => {
    mockExistsSync.mockReturnValueOnce(false);
    mockExecFileSync
      .mockReturnValueOnce('  worktree-db-name\n') // local branch found
      .mockReturnValueOnce(''); // git worktree add

    const result = await resolveWorktreeOnResume({
      id: 'test-id-1234',
      working_directory: '/project/.claude/worktrees/old-path-name',
      worktree_name: 'db-name',
    }, mockQuery);

    expect(result).toBe('/project/.claude/worktrees/old-path-name');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['branch', '--list', 'worktree-db-name'],
      expect.objectContaining({ cwd: '/project' })
    );
  });

  it('returns non-worktree path unchanged even if directory is missing', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await resolveWorktreeOnResume({
      id: 'test-id-1234',
      working_directory: '/some/other/path',
      worktree_name: null,
    }, mockQuery);

    expect(result).toBe('/some/other/path');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
