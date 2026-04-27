import { describe, it, expect, beforeAll } from 'vitest';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env before importing database
// The .env is in the root project directory (parent of .claude/)
const { existsSync } = await import('fs');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Walk up 5 levels: server/__tests__ -> server -> worktree -> worktrees -> .claude -> root
let envPath = path.resolve(__dirname, '../../../../../.env');
if (!existsSync(envPath)) {
  // Fallback: try 4 levels up
  envPath = path.resolve(__dirname, '../../../../.env');
}
dotenv.config({ path: envPath, override: true });

// Dynamic import to ensure .env is loaded first
const { query, initializeDb } = await import('../database.js');

describe('pipeline schema', () => {
  beforeAll(async () => {
    await initializeDb();
  });

  it('has a pipelines table with the expected columns', async () => {
    const result = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'pipelines'
    `);
    const columns = result.rows.map((r) => r.column_name);
    expect(columns).toEqual(expect.arrayContaining([
      'id', 'name', 'project_id', 'branch_name', 'status', 'current_stage',
      'fix_cycle_count', 'pr_url', 'spec_input',
      'created_at', 'updated_at', 'completed_at',
    ]));
  });

  it('has a pipeline_stage_outputs table with the expected columns', async () => {
    const result = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'pipeline_stage_outputs'
    `);
    const columns = result.rows.map((r) => r.column_name);
    expect(columns).toEqual(expect.arrayContaining([
      'id', 'pipeline_id', 'stage', 'iteration', 'output_path',
      'status', 'approved_at', 'created_at',
    ]));
  });

  it('has a pipeline_stage_prompts table with the expected columns', async () => {
    const result = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'pipeline_stage_prompts'
    `);
    const columns = result.rows.map((r) => r.column_name);
    expect(columns).toEqual(expect.arrayContaining([
      'id', 'pipeline_id', 'stage', 'prompt', 'updated_at',
    ]));
  });

  it('adds pipeline_id and pipeline_stage columns to sessions', async () => {
    const result = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'sessions' AND column_name IN ('pipeline_id', 'pipeline_stage')
    `);
    const columns = result.rows.map((r) => r.column_name);
    expect(columns).toEqual(expect.arrayContaining(['pipeline_id', 'pipeline_stage']));
  });
});
