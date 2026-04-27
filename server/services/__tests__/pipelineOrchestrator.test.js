import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let envPath = path.resolve(__dirname, '../../../../../../.env');
if (!existsSync(envPath)) {
  envPath = path.resolve(__dirname, '../../../../../.env');
}
dotenv.config({ path: envPath, override: true });

const require = createRequire(import.meta.url);
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const TEST_PROJECT_ID = `test-orch-${crypto.randomBytes(4).toString('hex')}`;
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-orch-'));

let query, initializeDb, repo, orchestratorMod;

beforeAll(async () => {
  ({ query, initializeDb } = require('../../database'));
  repo = require('../pipelineRepo');
  orchestratorMod = require('../pipelineOrchestrator');
  await initializeDb();
  await query(
    `INSERT INTO projects (id, name, root_path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [TEST_PROJECT_ID, 'orch test project', TEST_ROOT]
  );
});

describe('pipelineOrchestrator', () => {
  let orchestrator;
  let deps;

  beforeEach(async () => {
    await query('DELETE FROM pipelines WHERE project_id = $1', [TEST_PROJECT_ID]);
    deps = {
      createBranch: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue({ sessionId: 'sess_mock' }),
      readFileExists: vi.fn().mockReturnValue(true),
    };
    orchestrator = orchestratorMod.create(deps);
  });

  describe('createAndStart', () => {
    it('creates the pipeline, creates a branch, and starts stage 1', async () => {
      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID,
        name: 'Add foo',
        specInput: 'Build a foo widget.',
      });
      expect(pipeline.status).toBe('running');
      expect(pipeline.current_stage).toBe(1);
      expect(deps.createBranch).toHaveBeenCalledWith(
        expect.objectContaining({ branchName: pipeline.branch_name, projectRootPath: TEST_ROOT })
      );
      expect(deps.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: TEST_PROJECT_ID,
          sessionType: 'spec_refinement',
          pipelineId: pipeline.id,
          pipelineStage: 1,
        })
      );
    });

    it('refuses to start if the project already has an active pipeline', async () => {
      await orchestrator.createAndStart({ projectId: TEST_PROJECT_ID, name: 'P1', specInput: 's' });
      await expect(
        orchestrator.createAndStart({ projectId: TEST_PROJECT_ID, name: 'P2', specInput: 's' })
      ).rejects.toThrow(/already has an active pipeline/i);
    });
  });

  describe('handleSessionComplete', () => {
    it('records the stage output and pauses for approval on a gated stage', async () => {
      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID, name: 'Add foo', specInput: 's',
      });
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_mock',
        pipelineId: pipeline.id,
        pipelineStage: 1,
      });
      const updated = await repo.getPipeline(pipeline.id);
      expect(updated.status).toBe('paused_for_approval');
      const outputs = await repo.listStageOutputs(pipeline.id);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].stage).toBe(1);
      expect(outputs[0].output_path).toBe('docs/specs/add-foo-refined.md');
    });

    it('marks the pipeline as failed-stage if the output file is missing', async () => {
      deps.readFileExists.mockReturnValue(false);
      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID, name: 'Add foo', specInput: 's',
      });
      // First failure should trigger a single retry.
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_mock',
        pipelineId: pipeline.id,
        pipelineStage: 1,
      });
      expect(deps.startSession).toHaveBeenCalledTimes(2);
      const updated = await repo.getPipeline(pipeline.id);
      expect(updated.status).toBe('running');

      // Second failure should pause for failure.
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_mock',
        pipelineId: pipeline.id,
        pipelineStage: 1,
      });
      const final = await repo.getPipeline(pipeline.id);
      expect(final.status).toBe('paused_for_failure');
    });
  });

  describe('approve', () => {
    it('marks the latest stage output approved and starts the next stage', async () => {
      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID, name: 'Add foo', specInput: 's',
      });
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_mock', pipelineId: pipeline.id, pipelineStage: 1,
      });
      deps.startSession.mockClear();
      await orchestrator.approveCurrentStage(pipeline.id);
      const updated = await repo.getPipeline(pipeline.id);
      expect(updated.status).toBe('running');
      expect(updated.current_stage).toBe(2);
      expect(deps.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionType: 'qa_design', pipelineStage: 2 })
      );
    });

    it('completes the pipeline after stage 3 approval', async () => {
      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID, name: 'Add foo', specInput: 's',
      });
      // Run through stages 1, 2, 3.
      for (const stage of [1, 2, 3]) {
        await orchestrator.handleSessionComplete({
          sessionId: 'sess_mock', pipelineId: pipeline.id, pipelineStage: stage,
        });
        if (stage < 3) {
          await orchestrator.approveCurrentStage(pipeline.id);
        }
      }
      // Approve stage 3 — should complete the pipeline (Phase 1 stops here).
      await orchestrator.approveCurrentStage(pipeline.id);
      const final = await repo.getPipeline(pipeline.id);
      expect(final.status).toBe('completed');
      expect(final.completed_at).not.toBeNull();
    });
  });

  describe('reject', () => {
    it('marks the stage rejected and re-runs the stage with the feedback', async () => {
      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID, name: 'Add foo', specInput: 's',
      });
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_mock', pipelineId: pipeline.id, pipelineStage: 1,
      });
      deps.startSession.mockClear();
      await orchestrator.rejectCurrentStage(pipeline.id, 'Too vague.');
      const outputs = await repo.listStageOutputs(pipeline.id);
      expect(outputs[0].status).toBe('rejected');
      expect(deps.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionType: 'spec_refinement',
          pipelineStage: 1,
          rejectionFeedback: 'Too vague.',
        })
      );
      const updated = await repo.getPipeline(pipeline.id);
      expect(updated.status).toBe('running');
    });
  });
});
