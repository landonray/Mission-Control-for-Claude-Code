import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { appendOwnerDecisionToContextDoc } = require('../services/contextDocAppender');

describe('appendOwnerDecisionToContextDoc', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxdoc-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends a decision to PRODUCT.md', async () => {
    const target = path.join(tmpDir, 'PRODUCT.md');
    fs.writeFileSync(target, '# Product\n\nExisting content.\n');
    const result = await appendOwnerDecisionToContextDoc({
      projectRoot: tmpDir,
      doc: 'PRODUCT.md',
      question: 'Should we keep SQLite?',
      answer: 'Yes for one more release.',
      timestamp: '2026-04-25T12:00:00Z',
    });
    expect(result.path).toBe(target);
    expect(result.created).toBe(false);
    const content = fs.readFileSync(target, 'utf8');
    expect(content).toContain('Existing content.');
    expect(content).toMatch(/## Decision \(2026-04-25\): Should we keep SQLite\?/);
    expect(content).toContain('Yes for one more release.');
  });

  it('creates the file if it does not exist', async () => {
    const target = path.join(tmpDir, 'ARCHITECTURE.md');
    const result = await appendOwnerDecisionToContextDoc({
      projectRoot: tmpDir,
      doc: 'ARCHITECTURE.md',
      question: 'Q', answer: 'A',
      timestamp: '2026-04-25T12:00:00Z',
    });
    expect(result.created).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    const content = fs.readFileSync(target, 'utf8');
    expect(content).toContain('# Architecture');
    expect(content).toContain('## Decision (2026-04-25): Q');
  });

  it('rejects unknown doc names', async () => {
    await expect(
      appendOwnerDecisionToContextDoc({
        projectRoot: tmpDir,
        doc: 'EVIL.md',
        question: 'Q', answer: 'A',
      })
    ).rejects.toThrow(/PRODUCT\.md or ARCHITECTURE\.md/);
  });

  it('truncates a long question summary', async () => {
    const longQuestion = 'A'.repeat(200);
    await appendOwnerDecisionToContextDoc({
      projectRoot: tmpDir,
      doc: 'PRODUCT.md',
      question: longQuestion,
      answer: 'A',
      timestamp: '2026-04-25T12:00:00Z',
    });
    const content = fs.readFileSync(path.join(tmpDir, 'PRODUCT.md'), 'utf8');
    expect(content).toMatch(/## Decision \(2026-04-25\): A{120}\n/);
  });
});
