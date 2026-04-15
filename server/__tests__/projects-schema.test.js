import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests that verify the database schema in database.js contains the
 * required CREATE TABLE and ALTER TABLE statements for projects support.
 *
 * We read and parse the source file directly — this matches the pattern
 * used elsewhere in the project of testing logic in isolation, and avoids
 * the complexity of mocking the CJS neon driver for module-level side effects.
 */

const dbSource = readFileSync(resolve(__dirname, '../database.js'), 'utf8');

// Extract the statements array content (between the opening [ and the closing ] before migrations)
function extractStatements(source) {
  // Find all CREATE TABLE ... strings in the statements array
  const matches = [...source.matchAll(/`(CREATE TABLE IF NOT EXISTS[\s\S]*?)`/g)];
  return matches.map(m => m[1]);
}

// Extract all migration strings
function extractMigrations(source) {
  const matches = [...source.matchAll(/`(ALTER TABLE[\s\S]*?)`/g)];
  return matches.map(m => m[1]);
}

describe('projects table schema', () => {
  it('has a CREATE TABLE statement for projects', () => {
    const statements = extractStatements(dbSource);
    const projectsTable = statements.find(s => s.includes('CREATE TABLE IF NOT EXISTS projects'));
    expect(projectsTable).toBeDefined();
  });

  it('projects table has id TEXT PRIMARY KEY', () => {
    const statements = extractStatements(dbSource);
    const projectsTable = statements.find(s => s.includes('CREATE TABLE IF NOT EXISTS projects'));
    expect(projectsTable).toContain('id TEXT PRIMARY KEY');
  });

  it('projects table has name TEXT NOT NULL', () => {
    const statements = extractStatements(dbSource);
    const projectsTable = statements.find(s => s.includes('CREATE TABLE IF NOT EXISTS projects'));
    expect(projectsTable).toContain('name TEXT NOT NULL');
  });

  it('projects table has root_path TEXT NOT NULL UNIQUE', () => {
    const statements = extractStatements(dbSource);
    const projectsTable = statements.find(s => s.includes('CREATE TABLE IF NOT EXISTS projects'));
    expect(projectsTable).toContain('root_path TEXT NOT NULL');
    expect(projectsTable).toContain('UNIQUE');
  });

  it('projects table has created_at column', () => {
    const statements = extractStatements(dbSource);
    const projectsTable = statements.find(s => s.includes('CREATE TABLE IF NOT EXISTS projects'));
    expect(projectsTable).toContain('created_at');
  });

  it('projects table has settings JSONB column', () => {
    const statements = extractStatements(dbSource);
    const projectsTable = statements.find(s => s.includes('CREATE TABLE IF NOT EXISTS projects'));
    expect(projectsTable).toContain('settings JSONB');
  });
});

describe('sessions project_id migration', () => {
  it('has an ALTER TABLE migration to add project_id to sessions', () => {
    const migrations = extractMigrations(dbSource);
    const migration = migrations.find(
      s => s.includes('ALTER TABLE sessions') && s.includes('project_id')
    );
    expect(migration).toBeDefined();
  });

  it('migration uses ADD COLUMN IF NOT EXISTS', () => {
    const migrations = extractMigrations(dbSource);
    const migration = migrations.find(
      s => s.includes('ALTER TABLE sessions') && s.includes('project_id')
    );
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS');
  });
});
