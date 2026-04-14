import { execSync, execFileSync } from 'child_process';
import fs from 'fs';

const WORKTREE_PATH_PATTERN = /\/\.claude\/worktrees\//;

/**
 * Validate that a path is a worktree path.
 */
function isWorktreePath(p) {
  return p && WORKTREE_PATH_PATTERN.test(p);
}

/**
 * Check if a worktree directory has uncommitted changes.
 */
export function getWorktreeStatus(worktreePath) {
  const result = {
    hasUncommittedChanges: false,
    worktreePath,
  };

  if (!isWorktreePath(worktreePath) || !fs.existsSync(worktreePath)) {
    return result;
  }

  try {
    const output = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 5000,
    });
    result.hasUncommittedChanges = output.trim().length > 0;
  } catch (e) {
    // If git fails, treat as no changes (safe default — will just end normally)
  }

  return result;
}

/**
 * Auto-commit all changes in a worktree with a WIP message.
 */
export function commitWorktreeChanges(worktreePath) {
  if (!isWorktreePath(worktreePath) || !fs.existsSync(worktreePath)) {
    return;
  }

  const opts = { cwd: worktreePath, encoding: 'utf-8', timeout: 10000 };
  const date = new Date().toISOString().split('T')[0];

  try {
    execFileSync('git', ['add', '-A'], opts);
    execFileSync('git', ['commit', '-m', `WIP: session work from ${date}`], opts);
  } catch (e) {
    console.error(`[worktreeCleanup] Failed to commit in ${worktreePath}:`, e.message);
  }
}

/**
 * Check if a branch has an open pull request on GitHub.
 * Returns the first open PR's info, or null if none found.
 */
export function checkBranchPR(branchName, projectRoot) {
  if (!branchName || !projectRoot) return null;

  try {
    const output = execFileSync('gh', [
      'pr', 'list',
      '--head', branchName,
      '--state', 'open',
      '--json', 'number,title,url',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 10000,
    });

    const prs = JSON.parse(output);
    if (prs.length === 0) return null;

    return {
      number: prs[0].number,
      title: prs[0].title,
      url: prs[0].url,
    };
  } catch (e) {
    // gh CLI not available or failed — treat as no PR (safe default)
    return null;
  }
}

/**
 * Remove a worktree directory and optionally delete its branch.
 * Errors are logged but never thrown — cleanup must not block session ending.
 */
export function cleanupWorktree(worktreePath, branchName, projectRoot, deleteBranch) {
  const opts = { cwd: projectRoot, encoding: 'utf-8', timeout: 10000 };

  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], opts);
  } catch (e) {
    console.error(`[worktreeCleanup] Failed to remove worktree ${worktreePath}:`, e.message);
  }

  if (!deleteBranch || !branchName) return;

  try {
    execFileSync('git', ['branch', '-D', branchName], opts);
  } catch (e) {
    console.error(`[worktreeCleanup] Failed to delete local branch ${branchName}:`, e.message);
  }

  try {
    execFileSync('git', ['push', 'origin', '--delete', branchName], opts);
  } catch (e) {
    // Expected to fail if branch was never pushed
  }
}
