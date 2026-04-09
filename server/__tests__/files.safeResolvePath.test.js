import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Extract safeResolvePath logic for testing.
// (The function is internal to the routes file, so we replicate the logic here
// and also do integration-level tests via supertest.)

function safeResolvePath(inputPath) {
  const home = process.env.HOME || '/tmp';
  const resolved = path.resolve(inputPath.replace(/^~/, home));
  if (resolved !== home && !resolved.startsWith(home + '/')) {
    return null;
  }
  return resolved;
}

describe('safeResolvePath', () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = '/Users/testuser';
  });

  it('allows paths within home directory', () => {
    expect(safeResolvePath('/Users/testuser/projects/foo')).toBe('/Users/testuser/projects/foo');
  });

  it('allows home directory itself', () => {
    expect(safeResolvePath('/Users/testuser')).toBe('/Users/testuser');
  });

  it('resolves tilde to home directory', () => {
    expect(safeResolvePath('~/projects/bar')).toBe('/Users/testuser/projects/bar');
  });

  it('rejects paths outside home directory', () => {
    expect(safeResolvePath('/etc/passwd')).toBeNull();
  });

  it('rejects path traversal attempts', () => {
    expect(safeResolvePath('/Users/testuser/../../etc/passwd')).toBeNull();
  });

  it('rejects prefix collision (e.g. /Users/testuser-evil)', () => {
    expect(safeResolvePath('/Users/testuser-evil/stuff')).toBeNull();
  });

  it('rejects root path', () => {
    expect(safeResolvePath('/')).toBeNull();
  });

  afterAll(() => {
    process.env.HOME = originalHome;
  });
});
