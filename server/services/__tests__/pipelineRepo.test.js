import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Load DATABASE_URL from the main repo .env if not already set.
// The worktree does not have its own .env so we fall back to the parent.
if (!process.env.DATABASE_URL) {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.resolve('/Users/landonray/Coding Projects/Command Center/.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim();
      }
    }
  }
}

const crypto = require('crypto');

let query, initializeDb, repo;

const TEST_PROJECT_ID = `test-pipe-${crypto.randomBytes(4).toString('hex')}`;

beforeAll(async () => {
  ({ query, initializeDb } = require('../../database'));
  repo = require('../pipelineRepo');
  await initializeDb();
  await query(
    `INSERT INTO projects (id, name, root_path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [TEST_PROJECT_ID, 'pipeline test project', `/tmp/pipeline-test-${TEST_PROJECT_ID}`]
  );
});

describe('pipelineRepo', () => {
  beforeEach(async () => {
    await query('DELETE FROM pipelines WHERE project_id = $1', [TEST_PROJECT_ID]);
  });

  describe('createPipeline', () => {
    it('creates a pipeline with draft status and seeds default prompts', async () => {
      const pipeline = await repo.createPipeline({
        projectId: TEST_PROJECT_ID,
        name: 'Add pagination',
        specInput: 'We need pagination on the users page.',
      });
      expect(pipeline.id).toBeDefined();
      expect(pipeline.status).toBe('draft');
      expect(pipeline.branch_name).toMatch(/^pipeline-add-pagination/);
      expect(pipeline.spec_input).toBe('We need pagination on the users page.');

      const prompts = await repo.getStagePrompts(pipeline.id);
      expect(prompts).toHaveProperty('1');
      expect(prompts).toHaveProperty('2');
      expect(prompts).toHaveProperty('3');
      expect(prompts['1'].length).toBeGreaterThan(100);
    });

    it('produces a sanitized branch name', async () => {
      const pipeline = await repo.createPipeline({
        projectId: TEST_PROJECT_ID,
        name: 'Add WACKY!! Stuff & Things',
        specInput: 'spec',
      });
      expect(pipeline.branch_name).toBe('pipeline-add-wacky-stuff-things');
    });
  });

  describe('listPipelines', () => {
    it('returns pipelines for a project, newest first', async () => {
      await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'A', specInput: 'spec' });
      await new Promise((r) => setTimeout(r, 10));
      await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'B', specInput: 'spec' });
      const list = await repo.listPipelines(TEST_PROJECT_ID);
      expect(list).toHaveLength(2);
      expect(list[0].name).toBe('B');
      expect(list[1].name).toBe('A');
    });
  });

  describe('updateStatus', () => {
    it('updates pipeline status and current_stage', async () => {
      const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'X', specInput: 'spec' });
      await repo.updateStatus(p.id, { status: 'running', currentStage: 1 });
      const updated = await repo.getPipeline(p.id);
      expect(updated.status).toBe('running');
      expect(updated.current_stage).toBe(1);
    });
  });

  describe('recordStageOutput', () => {
    it('inserts a stage output row', async () => {
      const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'X', specInput: 'spec' });
      const output = await repo.recordStageOutput({
        pipelineId: p.id,
        stage: 1,
        iteration: 1,
        outputPath: 'docs/specs/x-refined.md',
      });
      expect(output.id).toBeDefined();
      expect(output.status).toBe('completed');

      const outputs = await repo.listStageOutputs(p.id);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].output_path).toBe('docs/specs/x-refined.md');
    });
  });

  describe('approveStageOutput', () => {
    it('marks the most recent stage output as approved', async () => {
      const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'X', specInput: 'spec' });
      await repo.recordStageOutput({ pipelineId: p.id, stage: 1, iteration: 1, outputPath: 'a.md' });
      await repo.approveStageOutput(p.id, 1);
      const outputs = await repo.listStageOutputs(p.id);
      expect(outputs[0].status).toBe('approved');
      expect(outputs[0].approved_at).not.toBeNull();
    });
  });

  describe('updateStagePrompt', () => {
    it('updates a single stage prompt', async () => {
      const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'X', specInput: 'spec' });
      await repo.updateStagePrompt(p.id, 1, 'CUSTOM PROMPT FOR STAGE 1');
      const prompts = await repo.getStagePrompts(p.id);
      expect(prompts['1']).toBe('CUSTOM PROMPT FOR STAGE 1');
      expect(prompts['2']).not.toBe('CUSTOM PROMPT FOR STAGE 1');
    });
  });
});
