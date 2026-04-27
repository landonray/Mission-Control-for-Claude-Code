import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { createRequire } from 'module';

// Load .env before importing modules that read it.
// server/services/__tests__ → walk up to find the .env (5 or 6 levels depending on
// whether we're running from the worktree or the main repo).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let envPath = path.resolve(__dirname, '../../../../../../.env');
if (!existsSync(envPath)) {
  envPath = path.resolve(__dirname, '../../../../../.env');
}
dotenv.config({ path: envPath, override: true });

const require = createRequire(import.meta.url);
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

    it('seeds default prompts for stages 4-7 too', async () => {
      const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'X', specInput: 'spec' });
      const prompts = await repo.getStagePrompts(p.id);
      for (const stage of ['4', '5', '6', '7']) {
        expect(prompts[stage]).toBeDefined();
        expect(prompts[stage].length).toBeGreaterThan(50);
      }
    });
  });

  describe('chunks', () => {
    it('creates and lists chunks in order', async () => {
      const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'Chunky', specInput: 'spec' });
      await repo.createChunks(p.id, [
        { index: 1, name: 'first', body: 'do this', files: 'a.js', qaScenarios: 'a', dependencies: 'none', complexity: 'small' },
        { index: 2, name: 'second', body: 'then this', files: 'b.js', qaScenarios: 'b', dependencies: '1', complexity: 'medium' },
      ]);
      const list = await repo.listChunks(p.id);
      expect(list).toHaveLength(2);
      expect(list[0].chunk_index).toBe(1);
      expect(list[0].name).toBe('first');
      expect(list[1].chunk_index).toBe(2);
      expect(list[1].complexity).toBe('medium');
    });

    it('marks a chunk running and completed', async () => {
      const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'Chunky', specInput: 'spec' });
      await repo.createChunks(p.id, [
        { index: 1, name: 'one', body: 'b', files: '', qaScenarios: '', dependencies: '', complexity: '' },
      ]);
      const next = await repo.getNextPendingChunk(p.id);
      expect(next.chunk_index).toBe(1);
      expect(next.status).toBe('pending');

      const sessionId = `sess-${crypto.randomBytes(4).toString('hex')}`;
      await query(
        `INSERT INTO sessions (id, name, status) VALUES ($1, 'fake', 'idle')`,
        [sessionId]
      );
      await repo.markChunkRunning(p.id, 1, sessionId);
      const running = (await repo.listChunks(p.id))[0];
      expect(running.status).toBe('running');
      expect(running.session_id).toBe(sessionId);
      expect(running.started_at).not.toBeNull();

      await repo.markChunkCompleted(p.id, 1);
      const done = (await repo.listChunks(p.id))[0];
      expect(done.status).toBe('completed');
      expect(done.completed_at).not.toBeNull();

      const noNext = await repo.getNextPendingChunk(p.id);
      expect(noNext).toBeNull();

      await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    });

    it('finds a chunk by session id', async () => {
      const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'Chunky', specInput: 'spec' });
      await repo.createChunks(p.id, [
        { index: 1, name: 'one', body: 'b', files: '', qaScenarios: '', dependencies: '', complexity: '' },
      ]);
      const sessionId = `sess-${crypto.randomBytes(4).toString('hex')}`;
      await query(
        `INSERT INTO sessions (id, name, status) VALUES ($1, 'fake', 'idle')`,
        [sessionId]
      );
      await repo.markChunkRunning(p.id, 1, sessionId);
      const found = await repo.findChunkBySessionId(sessionId);
      expect(found).not.toBeNull();
      expect(found.pipeline_id).toBe(p.id);
      expect(found.chunk_index).toBe(1);
      await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    });
  });

  describe('fix cycle', () => {
    it('increments fix_cycle_count', async () => {
      const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'X', specInput: 'spec' });
      const after1 = await repo.incrementFixCycleCount(p.id);
      expect(after1).toBe(1);
      const after2 = await repo.incrementFixCycleCount(p.id);
      expect(after2).toBe(2);
    });
  });

  describe('escalation', () => {
    it('records and resolves an escalation', async () => {
      const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'X', specInput: 'spec' });
      const esc = await repo.createEscalation({
        pipelineId: p.id, stage: 7, summary: 'Stuck after 3 fix cycles', detail: 'QA still failing',
      });
      expect(esc.id).toBeDefined();
      expect(esc.status).toBe('open');

      const open = await repo.listOpenEscalations(p.id);
      expect(open).toHaveLength(1);

      await repo.resolveEscalation(esc.id);
      const after = await repo.listOpenEscalations(p.id);
      expect(after).toHaveLength(0);
    });
  });
});
