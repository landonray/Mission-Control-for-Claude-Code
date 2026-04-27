import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'module';

process.env.DATABASE_URL = 'postgresql://test:test@host.test/db';

const require = createRequire(import.meta.url);

const databasePath = path.resolve(__dirname, '..', 'database.js');
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
};

const { findClaudeTranscript, ensureTranscriptAtCwd } = require('../services/sessionManager.js');

describe('transcript resolution helpers', () => {
  let tmpRoot;
  const sessionId = 'd1ad5787-a386-4f58-858d-4142984c2b9c';

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-transcript-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('findClaudeTranscript', () => {
    it('returns the absolute path when the transcript exists in any project dir', () => {
      const projectDir = path.join(tmpRoot, '-some-encoded-project-dir');
      fs.mkdirSync(projectDir, { recursive: true });
      const transcript = path.join(projectDir, `${sessionId}.jsonl`);
      fs.writeFileSync(transcript, '{"type":"user"}\n');

      expect(findClaudeTranscript(sessionId, tmpRoot)).toBe(transcript);
    });

    it('returns null when no transcript exists anywhere', () => {
      fs.mkdirSync(path.join(tmpRoot, '-empty-dir'), { recursive: true });
      expect(findClaudeTranscript(sessionId, tmpRoot)).toBeNull();
    });

    it('returns null when projectsRoot itself does not exist', () => {
      expect(findClaudeTranscript(sessionId, path.join(tmpRoot, 'nonexistent'))).toBeNull();
    });

    it('returns null when cliSessionId is empty', () => {
      expect(findClaudeTranscript(null, tmpRoot)).toBeNull();
      expect(findClaudeTranscript('', tmpRoot)).toBeNull();
    });
  });

  describe('ensureTranscriptAtCwd', () => {
    const cwd = '/Users/test/Projects/Demo';
    const expectedEncoded = '-Users-test-Projects-Demo';

    it('returns true without copying when the transcript already lives at the expected project dir', () => {
      const expectedDir = path.join(tmpRoot, expectedEncoded);
      fs.mkdirSync(expectedDir, { recursive: true });
      const expectedPath = path.join(expectedDir, `${sessionId}.jsonl`);
      fs.writeFileSync(expectedPath, '{"a":1}\n');

      expect(ensureTranscriptAtCwd(cwd, sessionId, tmpRoot)).toBe(true);
      // Still exactly one copy of the transcript on disk
      const all = fs.readdirSync(tmpRoot, { recursive: true })
        .filter(p => typeof p === 'string' && p.endsWith(`${sessionId}.jsonl`));
      expect(all.length).toBe(1);
    });

    it('copies an orphaned transcript from another project dir and returns true', () => {
      const otherDir = path.join(tmpRoot, '-Users-test-Projects-Demo--claude-worktrees-deleted-pumpkin');
      fs.mkdirSync(otherDir, { recursive: true });
      const orphanPath = path.join(otherDir, `${sessionId}.jsonl`);
      fs.writeFileSync(orphanPath, '{"orphan":true}\n');

      expect(ensureTranscriptAtCwd(cwd, sessionId, tmpRoot)).toBe(true);

      const expectedPath = path.join(tmpRoot, expectedEncoded, `${sessionId}.jsonl`);
      expect(fs.existsSync(expectedPath)).toBe(true);
      expect(fs.readFileSync(expectedPath, 'utf-8')).toBe('{"orphan":true}\n');
      // Original is preserved (copy, not move)
      expect(fs.existsSync(orphanPath)).toBe(true);
    });

    it('returns false when no transcript exists anywhere', () => {
      expect(ensureTranscriptAtCwd(cwd, sessionId, tmpRoot)).toBe(false);
      // Nothing was created
      expect(fs.existsSync(path.join(tmpRoot, expectedEncoded))).toBe(false);
    });

    it('returns false when workingDirectory or cliSessionId is missing', () => {
      expect(ensureTranscriptAtCwd('', sessionId, tmpRoot)).toBe(false);
      expect(ensureTranscriptAtCwd(cwd, null, tmpRoot)).toBe(false);
      expect(ensureTranscriptAtCwd(null, null, tmpRoot)).toBe(false);
    });
  });
});
