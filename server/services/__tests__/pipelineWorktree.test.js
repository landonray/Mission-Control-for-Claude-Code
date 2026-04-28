// Integration test for the per-pipeline worktree helpers in pipelineRuntime.
// Spins up a real on-disk git repo so we exercise the actual `git worktree`
// commands rather than mocking them — the whole point of the worktree-per-
// pipeline change is git-correctness, so faking git would defeat the test.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_URL ||= 'postgres://stub:stub@stub.invalid/stub';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const runtime = require('../pipelineRuntime');

let repoRoot;

function git(args, cwd = repoRoot) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

beforeAll(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-wt-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# test\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
});

afterAll(() => {
  if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('pipelineRuntime worktree helpers', () => {
  it('creates a branch and a per-pipeline worktree on disk', () => {
    const branchName = 'pipeline-test-aaa-11111111';
    const worktreePath = runtime._internal.createBranchAndWorktree({
      branchName,
      projectRootPath: repoRoot,
    });

    expect(worktreePath).toBe(path.join(repoRoot, '.claude', 'worktrees', branchName));
    expect(fs.existsSync(worktreePath)).toBe(true);
    // The worktree should have the branch checked out.
    const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
    expect(head).toBe(branchName);
    // The branch should exist in the main repo's ref list.
    const refs = git(['branch', '--list', branchName]);
    expect(refs).toContain(branchName);
  });

  it('two pipelines on the same project get isolated worktrees on different branches', () => {
    const branchA = 'pipeline-concurrent-a-aaaaaaaa';
    const branchB = 'pipeline-concurrent-b-bbbbbbbb';
    const wtA = runtime._internal.createBranchAndWorktree({ branchName: branchA, projectRootPath: repoRoot });
    const wtB = runtime._internal.createBranchAndWorktree({ branchName: branchB, projectRootPath: repoRoot });

    expect(wtA).not.toBe(wtB);
    expect(fs.existsSync(wtA)).toBe(true);
    expect(fs.existsSync(wtB)).toBe(true);

    // Make a commit in worktree A — it must not appear in worktree B.
    fs.writeFileSync(path.join(wtA, 'only-in-a.txt'), 'a\n');
    execFileSync('git', ['add', '.'], { cwd: wtA, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'a-only'], { cwd: wtA, stdio: 'ignore' });

    expect(fs.existsSync(path.join(wtA, 'only-in-a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(wtB, 'only-in-a.txt'))).toBe(false);
  });

  it('removeWorktree deletes the worktree directory and frees the branch lock', () => {
    const branchName = 'pipeline-removeme-cccccccc';
    const worktreePath = runtime._internal.createBranchAndWorktree({
      branchName,
      projectRootPath: repoRoot,
    });
    expect(fs.existsSync(worktreePath)).toBe(true);

    runtime._internal.removeWorktree({ projectRootPath: repoRoot, worktreePath });

    expect(fs.existsSync(worktreePath)).toBe(false);
    // The branch ref itself is preserved so PR creation / GitHub still has it.
    const refs = git(['branch', '--list', branchName]);
    expect(refs).toContain(branchName);
  });

  it('createBranchAndWorktree is idempotent — reusing the same branch returns the same path', () => {
    const branchName = 'pipeline-idempotent-dddddddd';
    const first = runtime._internal.createBranchAndWorktree({ branchName, projectRootPath: repoRoot });
    const second = runtime._internal.createBranchAndWorktree({ branchName, projectRootPath: repoRoot });
    expect(first).toBe(second);
    expect(fs.existsSync(second)).toBe(true);
  });
});
