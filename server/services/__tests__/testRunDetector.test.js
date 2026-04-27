import { describe, it, expect } from 'vitest';
import { detectFramework, isTestCommand } from '../testRunDetector.js';

describe('testRunDetector — detectFramework', () => {
  it('returns null for empty / non-string input', () => {
    expect(detectFramework('')).toBe(null);
    expect(detectFramework(null)).toBe(null);
    expect(detectFramework(undefined)).toBe(null);
    expect(detectFramework(42)).toBe(null);
  });

  it('detects vitest invocations', () => {
    expect(detectFramework('vitest run')).toBe('vitest');
    expect(detectFramework('npx vitest --run')).toBe('vitest');
    expect(detectFramework('VITEST_LOG=true vitest --watch=false')).toBe('vitest');
  });

  it('detects jest invocations', () => {
    expect(detectFramework('jest')).toBe('jest');
    expect(detectFramework('npx jest --coverage')).toBe('jest');
  });

  it('detects pytest invocations', () => {
    expect(detectFramework('pytest')).toBe('pytest');
    expect(detectFramework('pytest -v tests/')).toBe('pytest');
    expect(detectFramework('python -m pytest')).toBe('pytest');
  });

  it('detects go test', () => {
    expect(detectFramework('go test ./...')).toBe('go');
  });

  it('detects cargo test', () => {
    expect(detectFramework('cargo test')).toBe('cargo');
  });

  it('detects playwright tests', () => {
    expect(detectFramework('playwright test')).toBe('playwright');
    expect(detectFramework('npx playwright test --project=chromium')).toBe('playwright');
  });

  it('detects npm/yarn/pnpm test scripts as a fallback', () => {
    expect(detectFramework('npm test')).toBe('npm-test');
    expect(detectFramework('npm run test')).toBe('npm-test');
    expect(detectFramework('yarn test')).toBe('npm-test');
    expect(detectFramework('pnpm test:unit')).toBe('npm-test');
    expect(detectFramework('bun test')).toBe('npm-test');
  });

  it('detects test runners after a `cd` prefix (chained with &&)', () => {
    expect(detectFramework('cd /path/to/repo && npx vitest run')).toBe('vitest');
    expect(detectFramework('cd "/Users/foo/My Project" && npx vitest run server/__tests__'))
      .toBe('vitest');
    expect(detectFramework('cd repo && pytest')).toBe('pytest');
    expect(detectFramework('cd repo && npm test')).toBe('npm-test');
  });

  it('detects test runners when piped to other commands', () => {
    expect(detectFramework('npx vitest run 2>&1 | tail -30')).toBe('vitest');
    expect(detectFramework('pytest -v | grep FAIL')).toBe('pytest');
  });

  it('detects test runners after env-var prefixes', () => {
    expect(detectFramework('CI=1 npx vitest run')).toBe('vitest');
    expect(detectFramework('NODE_ENV=test FOO=bar pytest')).toBe('pytest');
  });

  it('returns null for non-test commands that mention "test" incidentally', () => {
    expect(detectFramework('git commit -m "add tests for foo"')).toBe(null);
    expect(detectFramework('ls test/')).toBe(null);
    expect(detectFramework('cd test-fixtures')).toBe(null);
    expect(detectFramework('mkdir tests')).toBe(null);
    expect(detectFramework('echo "running tests"')).toBe(null);
    expect(detectFramework('cat test_results.txt')).toBe(null);
  });

  it('does not match test-runner names that appear inside quoted strings', () => {
    // PR body contains "npm test" in the test-plan checklist — should NOT match.
    expect(detectFramework(
      'gh pr create --title "feat: thing" --body "## Test plan\n- [ ] npm test passes\n- [ ] vitest green"'
    )).toBe(null);
    // Commit message containing test runner names
    expect(detectFramework('git commit -m "wire up vitest config and run pytest"')).toBe(null);
    // Quoted arg with --title containing "test"
    expect(detectFramework("git commit -m 'fix: pytest stability'")).toBe(null);
  });

  it('returns null for unrelated commands', () => {
    expect(detectFramework('npm install')).toBe(null);
    expect(detectFramework('node server.js')).toBe(null);
    expect(detectFramework('docker build .')).toBe(null);
  });

  it('isTestCommand mirrors detectFramework as boolean', () => {
    expect(isTestCommand('vitest')).toBe(true);
    expect(isTestCommand('npm install')).toBe(false);
    expect(isTestCommand('cd /path && npx vitest run')).toBe(true);
    expect(isTestCommand('gh pr create --body "npm test plan"')).toBe(false);
  });
});
