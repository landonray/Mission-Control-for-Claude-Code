import { describe, it, expect } from 'vitest';

const verifier = await import('../dbTablesVerifier.js');

describe('dbTablesVerifier.parseTables', () => {
  it('extracts every CREATE TABLE IF NOT EXISTS statement', () => {
    const content = `
      const queries = [
        \`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)\`,
        \`CREATE TABLE IF NOT EXISTS messages (id INTEGER, session_id TEXT)\`,
        \`CREATE TABLE IF NOT EXISTS pipelines (id TEXT)\`,
      ];
    `;
    expect(verifier.parseTables(content).map(t => t.name))
      .toEqual(['sessions', 'messages', 'pipelines']);
  });

  it('also matches plain CREATE TABLE without IF NOT EXISTS', () => {
    const content = 'CREATE TABLE foo_bar (id TEXT)';
    expect(verifier.parseTables(content).map(t => t.name)).toEqual(['foo_bar']);
  });

  it('deduplicates if the same table appears in multiple migrations', () => {
    const content = `
      CREATE TABLE IF NOT EXISTS foo (id INT);
      CREATE TABLE IF NOT EXISTS foo (id INT, extra TEXT);
    `;
    expect(verifier.parseTables(content).map(t => t.name)).toEqual(['foo']);
  });

  it('lowercases table names for stable comparison', () => {
    const content = 'CREATE TABLE IF NOT EXISTS Sessions (id TEXT)';
    expect(verifier.parseTables(content).map(t => t.name)).toEqual(['sessions']);
  });
});

describe('dbTablesVerifier.extract', () => {
  it('returns empty + notes when source file is missing', async () => {
    const result = await verifier.extract('/does/not/exist');
    expect(result.category).toBe('Database tables');
    expect(result.items).toEqual([]);
    expect(result.notes).toMatch(/not found/);
  });
});
