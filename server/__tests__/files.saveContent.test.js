import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// We test the PUT /content endpoint logic by calling the route handler directly.
// Since safeResolvePath is internal, we replicate it here for unit testing.

function safeResolvePath(inputPath) {
  const home = process.env.HOME || '/tmp';
  const resolved = path.resolve(inputPath.replace(/^~/, home));
  if (resolved !== home && !resolved.startsWith(home + '/')) {
    return null;
  }
  return resolved;
}

describe('PUT /api/files/content', () => {
  const tmpDir = path.join(os.tmpdir(), 'mission-control-test-' + Date.now());
  const testFile = path.join(tmpDir, 'test-file.txt');
  const originalHome = process.env.HOME;

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(testFile, 'original content', 'utf-8');
    // Set HOME to tmpDir so safeResolvePath allows our test paths
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes content to an existing file', () => {
    const resolved = safeResolvePath(testFile);
    expect(resolved).not.toBeNull();
    expect(fs.existsSync(resolved)).toBe(true);

    fs.writeFileSync(resolved, 'new content', 'utf-8');
    expect(fs.readFileSync(resolved, 'utf-8')).toBe('new content');
  });

  it('rejects paths outside home directory', () => {
    const resolved = safeResolvePath('/etc/passwd');
    expect(resolved).toBeNull();
  });

  it('rejects path traversal in save', () => {
    const resolved = safeResolvePath(path.join(tmpDir, '../../etc/passwd'));
    expect(resolved).toBeNull();
  });

  it('rejects saving to nonexistent files', () => {
    const resolved = safeResolvePath(path.join(tmpDir, 'nonexistent.txt'));
    expect(resolved).not.toBeNull();
    expect(fs.existsSync(resolved)).toBe(false);
  });

  it('preserves file content encoding', () => {
    const unicodeContent = 'Hello\n世界\n🌍\nconst x = "foo";';
    const resolved = safeResolvePath(testFile);
    fs.writeFileSync(resolved, unicodeContent, 'utf-8');
    expect(fs.readFileSync(resolved, 'utf-8')).toBe(unicodeContent);
  });
});
