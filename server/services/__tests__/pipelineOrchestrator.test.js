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
  const stubSessionIds = [];

  // Inserts a real (stub) session row so foreign keys from pipeline_chunks can
  // be satisfied. Tests that need to correlate completion events back to a
  // chunk pass the returned id back via handleSessionComplete.
  async function insertStubSession() {
    const id = `sess-stub-${crypto.randomBytes(4).toString('hex')}`;
    await query(`INSERT INTO sessions (id, name, status) VALUES ($1, 'stub', 'idle')`, [id]);
    stubSessionIds.push(id);
    return id;
  }

  beforeEach(async () => {
    await query('DELETE FROM pipelines WHERE project_id = $1', [TEST_PROJECT_ID]);
    if (stubSessionIds.length > 0) {
      await query(`DELETE FROM sessions WHERE id = ANY($1)`, [stubSessionIds.splice(0)]);
    }
    deps = {
      createBranch: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockImplementation(async ({ pipelineId, pipelineStage }) => {
        const sessionId = await insertStubSession();
        await query(
          `UPDATE sessions SET pipeline_id = $1, pipeline_stage = $2 WHERE id = $3`,
          [pipelineId, pipelineStage, sessionId]
        );
        return { sessionId };
      }),
      readFileExists: vi.fn().mockReturnValue(true),
      endSession: vi.fn().mockImplementation(async (sessionId) => {
        await query(
          `UPDATE sessions SET status = 'ended', ended_at = NOW() WHERE id = $1`,
          [sessionId]
        );
      }),
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

    it('advances to stage 4 (chunked implementation) after stage 3 approval', async () => {
      // Provide a parseable build plan via the optional readBuildPlan dep so
      // the orchestrator doesn't try to read the actual file system.
      deps.readBuildPlan = vi.fn().mockReturnValue([
        '## Chunk 1: only',
        '- Files: a.js',
        '- QA Scenarios: a',
        '- Dependencies: none',
        '- Complexity: small',
        '',
        'body',
      ].join('\n'));
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID, name: 'Add foo', specInput: 's',
      });
      for (const stage of [1, 2, 3]) {
        await orchestrator.handleSessionComplete({
          sessionId: 'sess_mock', pipelineId: pipeline.id, pipelineStage: stage,
        });
        if (stage < 3) await orchestrator.approveCurrentStage(pipeline.id);
      }
      await orchestrator.approveCurrentStage(pipeline.id);

      const after = await repo.getPipeline(pipeline.id);
      expect(after.status).toBe('running');
      expect(after.current_stage).toBe(4);
      const chunks = await repo.listChunks(pipeline.id);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].status).toBe('running');
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

  describe('Stage 4 (Implementation)', () => {
    const VALID_BUILD_PLAN = [
      '# Build plan',
      '',
      '## Chunk 1: First',
      '- Files: a.js',
      '- QA Scenarios: a',
      '- Dependencies: none',
      '- Complexity: small',
      '',
      'Body of first.',
      '',
      '## Chunk 2: Second',
      '- Files: b.js',
      '- QA Scenarios: b',
      '- Dependencies: 1',
      '- Complexity: medium',
      '',
      'Body of second.',
    ].join('\n');

    let stage3OutputPath;

    async function runThroughStage3(name = 'Add foo', specInput = 's') {
      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID, name, specInput,
      });
      // Walk through stages 1, 2, 3 — each session completes with the orchestrator
      // recording the output. The build plan content is read from disk by the
      // orchestrator via deps.readBuildPlan, which we mock to return our parseable plan.
      for (const stage of [1, 2, 3]) {
        await orchestrator.handleSessionComplete({
          sessionId: 'sess_mock', pipelineId: pipeline.id, pipelineStage: stage,
        });
        if (stage < 3) await orchestrator.approveCurrentStage(pipeline.id);
      }
      stage3OutputPath = require('../pipelinePromptBuilder').outputPathFor(3, pipeline.name);
      return pipeline;
    }

    it('parses the build plan, persists chunks, and starts chunk 1 when stage 3 is approved', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await runThroughStage3();
      deps.startSession.mockClear();

      await orchestrator.approveCurrentStage(pipeline.id);

      const updated = await repo.getPipeline(pipeline.id);
      expect(updated.current_stage).toBe(4);
      expect(updated.status).toBe('running');

      const chunks = await repo.listChunks(pipeline.id);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].chunk_index).toBe(1);
      expect(chunks[0].name).toBe('First');
      expect(chunks[0].status).toBe('running');
      expect(chunks[1].status).toBe('pending');

      expect(deps.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionType: 'implementation', pipelineStage: 4 })
      );
    });

    it('starts chunk 2 after chunk 1 completes', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await runThroughStage3();
      await orchestrator.approveCurrentStage(pipeline.id);
      const chunkOneSessionId = (await repo.listChunks(pipeline.id))[0].session_id;
      deps.startSession.mockClear();

      await orchestrator.handleSessionComplete({
        sessionId: chunkOneSessionId, pipelineId: pipeline.id, pipelineStage: 4,
      });

      const chunks = await repo.listChunks(pipeline.id);
      expect(chunks[0].status).toBe('completed');
      expect(chunks[1].status).toBe('running');
      expect(deps.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ pipelineStage: 4 })
      );
    });

    it('advances to stage 5 (QA execution) after the last chunk completes', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await runThroughStage3();
      await orchestrator.approveCurrentStage(pipeline.id);

      // Complete chunk 1 → starts chunk 2.
      const chunk1SessionId = (await repo.listChunks(pipeline.id))[0].session_id;
      await orchestrator.handleSessionComplete({
        sessionId: chunk1SessionId, pipelineId: pipeline.id, pipelineStage: 4,
      });

      // Complete chunk 2 → advances to stage 5.
      const chunk2SessionId = (await repo.listChunks(pipeline.id))[1].session_id;
      deps.startSession.mockClear();
      await orchestrator.handleSessionComplete({
        sessionId: chunk2SessionId, pipelineId: pipeline.id, pipelineStage: 4,
      });

      const updated = await repo.getPipeline(pipeline.id);
      expect(updated.current_stage).toBe(5);
      expect(updated.status).toBe('running');
      expect(deps.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionType: 'qa_execution', pipelineStage: 5 })
      );
    });

    it('escalates if the build plan cannot be parsed', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue('No chunks here, just prose.');
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await runThroughStage3();
      await orchestrator.approveCurrentStage(pipeline.id);

      const updated = await repo.getPipeline(pipeline.id);
      expect(updated.status).toBe('paused_for_failure');

      const escalations = await repo.listOpenEscalations(pipeline.id);
      expect(escalations).toHaveLength(1);
      expect(escalations[0].stage).toBe(4);
    });
  });

  describe('Stage 5 → Stage 6 (QA Execution)', () => {
    const VALID_BUILD_PLAN = [
      '## Chunk 1: only',
      '- Files: a.js',
      '- QA Scenarios: a',
      '- Dependencies: none',
      '- Complexity: small',
      '',
      'body',
    ].join('\n');

    async function runThroughStage4(orch, name = 'Add foo') {
      const pipeline = await orch.createAndStart({
        projectId: TEST_PROJECT_ID, name, specInput: 's',
      });
      for (const stage of [1, 2, 3]) {
        await orch.handleSessionComplete({
          sessionId: 'sess_mock', pipelineId: pipeline.id, pipelineStage: stage,
        });
        if (stage < 3) await orch.approveCurrentStage(pipeline.id);
      }
      await orch.approveCurrentStage(pipeline.id); // approve stage 3 → start stage 4
      // Complete the only chunk → advances to stage 5.
      const chunkSessionId = (await repo.listChunks(pipeline.id))[0].session_id;
      await orch.handleSessionComplete({
        sessionId: chunkSessionId, pipelineId: pipeline.id, pipelineStage: 4,
      });
      return pipeline;
    }

    it('advances to stage 6 when QA reports Overall: pass', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      deps.readStageOutput = vi.fn().mockReturnValue('# QA Report\n\nAll passed.\n\nOverall: pass\n');
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await runThroughStage4(orchestrator);
      deps.startSession.mockClear();
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_qa', pipelineId: pipeline.id, pipelineStage: 5,
      });

      const updated = await repo.getPipeline(pipeline.id);
      expect(updated.current_stage).toBe(6);
      expect(updated.status).toBe('running');
      expect(deps.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionType: 'code_review', pipelineStage: 6 })
      );
    });

    it('triggers fix cycle when QA reports Overall: fail', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      deps.readStageOutput = vi.fn().mockReturnValue('# QA Report\n\nFailed.\n\nOverall: fail\n');
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await runThroughStage4(orchestrator);
      deps.startSession.mockClear();
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_qa', pipelineId: pipeline.id, pipelineStage: 5,
      });

      const updated = await repo.getPipeline(pipeline.id);
      expect(updated.current_stage).toBe(7);
      expect(updated.fix_cycle_count).toBe(1);
      expect(deps.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ pipelineStage: 7 })
      );
    });
  });

  describe('Stage 6 (Code Review)', () => {
    const VALID_BUILD_PLAN = [
      '## Chunk 1: only',
      '- Files: a.js',
      '- QA Scenarios: a',
      '- Dependencies: none',
      '- Complexity: small',
      '',
      'body',
    ].join('\n');

    async function runThroughStage5Pass(orch) {
      const pipeline = await orch.createAndStart({
        projectId: TEST_PROJECT_ID, name: 'Review test', specInput: 's',
      });
      for (const stage of [1, 2, 3]) {
        await orch.handleSessionComplete({
          sessionId: 'sess_mock', pipelineId: pipeline.id, pipelineStage: stage,
        });
        if (stage < 3) await orch.approveCurrentStage(pipeline.id);
      }
      await orch.approveCurrentStage(pipeline.id);
      const chunkSessionId = (await repo.listChunks(pipeline.id))[0].session_id;
      await orch.handleSessionComplete({
        sessionId: chunkSessionId, pipelineId: pipeline.id, pipelineStage: 4,
      });
      await orch.handleSessionComplete({
        sessionId: 'sess_qa', pipelineId: pipeline.id, pipelineStage: 5,
      });
      return pipeline;
    }

    it('completes the pipeline when code review reports Blockers: 0', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      deps.readStageOutput = vi.fn()
        .mockReturnValueOnce('# QA\n\nOverall: pass\n')      // stage 5
        .mockReturnValueOnce('# Review\n\nClean.\n\nBlockers: 0\n'); // stage 6
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await runThroughStage5Pass(orchestrator);
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_review', pipelineId: pipeline.id, pipelineStage: 6,
      });

      const final = await repo.getPipeline(pipeline.id);
      expect(final.status).toBe('completed');
      expect(final.completed_at).not.toBeNull();
    });

    it('triggers fix cycle when code review reports Blockers: > 0', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      deps.readStageOutput = vi.fn()
        .mockReturnValueOnce('Overall: pass\n')
        .mockReturnValueOnce('# Review\n\nFound 2 blockers.\n\nBlockers: 2\n');
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await runThroughStage5Pass(orchestrator);
      deps.startSession.mockClear();
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_review', pipelineId: pipeline.id, pipelineStage: 6,
      });

      const updated = await repo.getPipeline(pipeline.id);
      expect(updated.current_stage).toBe(7);
      expect(updated.fix_cycle_count).toBe(1);
    });
  });

  describe('Stage 7 (Fix Cycle)', () => {
    const VALID_BUILD_PLAN = [
      '## Chunk 1: only',
      '- Files: a.js',
      '- QA Scenarios: a',
      '- Dependencies: none',
      '- Complexity: small',
      '',
      'body',
    ].join('\n');

    async function runToFixCycle(orch, qaText, reviewText) {
      const reads = [];
      if (qaText !== undefined) reads.push(qaText);
      if (reviewText !== undefined) reads.push(reviewText);
      // Note: the dep is set on the test's deps before the orchestrator is created.
      const pipeline = await orch.createAndStart({
        projectId: TEST_PROJECT_ID, name: `Fix-${crypto.randomBytes(2).toString('hex')}`, specInput: 's',
      });
      for (const stage of [1, 2, 3]) {
        await orch.handleSessionComplete({
          sessionId: 'sess_mock', pipelineId: pipeline.id, pipelineStage: stage,
        });
        if (stage < 3) await orch.approveCurrentStage(pipeline.id);
      }
      await orch.approveCurrentStage(pipeline.id);
      const chunkSessionId = (await repo.listChunks(pipeline.id))[0].session_id;
      await orch.handleSessionComplete({
        sessionId: chunkSessionId, pipelineId: pipeline.id, pipelineStage: 4,
      });
      await orch.handleSessionComplete({
        sessionId: 'sess_qa', pipelineId: pipeline.id, pipelineStage: 5,
      });
      return pipeline;
    }

    it('after a fix-cycle session ends, re-runs QA execution', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      deps.readStageOutput = vi.fn().mockReturnValue('Overall: fail\n');
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await runToFixCycle(orchestrator);
      // Pipeline is now in stage 7 (fix cycle), fix_cycle_count = 1.
      expect((await repo.getPipeline(pipeline.id)).current_stage).toBe(7);
      deps.startSession.mockClear();

      await orchestrator.handleSessionComplete({
        sessionId: 'sess_fix', pipelineId: pipeline.id, pipelineStage: 7,
      });

      const after = await repo.getPipeline(pipeline.id);
      expect(after.current_stage).toBe(5);
      expect(deps.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionType: 'qa_execution', pipelineStage: 5 })
      );
    });

    it('escalates after the 3rd fix cycle still fails QA', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      deps.readStageOutput = vi.fn().mockReturnValue('Overall: fail\n');
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await runToFixCycle(orchestrator);

      // We're already in fix-cycle 1. Drive 2 more fix→QA failures.
      // After fix 1 ends, QA runs (fail) → fix cycle 2.
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_fix1', pipelineId: pipeline.id, pipelineStage: 7,
      });
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_qa1', pipelineId: pipeline.id, pipelineStage: 5,
      });
      // After fix 2 ends, QA runs (fail) → fix cycle 3.
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_fix2', pipelineId: pipeline.id, pipelineStage: 7,
      });
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_qa2', pipelineId: pipeline.id, pipelineStage: 5,
      });
      // After fix 3 ends, QA runs (fail) → cap exceeded → escalate.
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_fix3', pipelineId: pipeline.id, pipelineStage: 7,
      });
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_qa3', pipelineId: pipeline.id, pipelineStage: 5,
      });

      const final = await repo.getPipeline(pipeline.id);
      expect(final.status).toBe('paused_for_escalation');
      expect(final.fix_cycle_count).toBe(4); // counter increments before cap check

      const escalations = await repo.listOpenEscalations(pipeline.id);
      expect(escalations).toHaveLength(1);
      expect(escalations[0].stage).toBe(7);
      expect(escalations[0].summary).toMatch(/3 fix cycles/);
    });

    it('completes when QA passes after a fix cycle and review has 0 blockers', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      // Sequence of stage-output reads: stage 5 (fail) → stage 5 (pass) → stage 6 (clean)
      deps.readStageOutput = vi.fn()
        .mockReturnValueOnce('Overall: fail\n')
        .mockReturnValueOnce('Overall: pass\n')
        .mockReturnValueOnce('Blockers: 0\n');
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await runToFixCycle(orchestrator);
      // We are now in stage 7, fix_cycle_count = 1.
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_fix', pipelineId: pipeline.id, pipelineStage: 7,
      });
      // After fix-cycle session ends, QA re-runs (which advances to stage 6 on pass).
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_qa2', pipelineId: pipeline.id, pipelineStage: 5,
      });
      // Code review session runs, completes the pipeline.
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_review', pipelineId: pipeline.id, pipelineStage: 6,
      });

      const final = await repo.getPipeline(pipeline.id);
      expect(final.status).toBe('completed');
      expect(final.completed_at).not.toBeNull();
    });
  });

  describe('configurable gating', () => {
    const VALID_BUILD_PLAN = [
      '## Chunk 1: only',
      '- Files: a.js',
      '- QA Scenarios: a',
      '- Dependencies: none',
      '- Complexity: small',
      '',
      'body',
    ].join('\n');

    it('skips the pause when stage 1 is not in gated_stages and auto-advances to stage 2', async () => {
      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID,
        name: 'No gates',
        specInput: 's',
        gatedStages: [], // nothing gated
      });
      deps.startSession.mockClear();

      await orchestrator.handleSessionComplete({
        sessionId: 'sess_mock',
        pipelineId: pipeline.id,
        pipelineStage: 1,
      });

      const updated = await repo.getPipeline(pipeline.id);
      expect(updated.status).toBe('running');
      expect(updated.current_stage).toBe(2);
      expect(deps.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ pipelineStage: 2 })
      );
    });

    it('still pauses on a stage that IS in gated_stages', async () => {
      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID,
        name: 'Gate 2 only',
        specInput: 's',
        gatedStages: [2],
      });

      // Stage 1 is not gated → auto-advances.
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_mock',
        pipelineId: pipeline.id,
        pipelineStage: 1,
      });
      let after = await repo.getPipeline(pipeline.id);
      expect(after.current_stage).toBe(2);
      expect(after.status).toBe('running');

      // Stage 2 is gated → pauses.
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_mock',
        pipelineId: pipeline.id,
        pipelineStage: 2,
      });
      after = await repo.getPipeline(pipeline.id);
      expect(after.status).toBe('paused_for_approval');
      expect(after.current_stage).toBe(2);
    });

    it('auto-advances through stage 3 into chunked implementation when stage 3 is not gated', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID,
        name: 'Skip gate 3',
        specInput: 's',
        gatedStages: [],
      });
      // Walk through 1, 2, 3 — all auto-advance because nothing is gated.
      for (const stage of [1, 2, 3]) {
        await orchestrator.handleSessionComplete({
          sessionId: 'sess_mock',
          pipelineId: pipeline.id,
          pipelineStage: stage,
        });
      }

      const after = await repo.getPipeline(pipeline.id);
      expect(after.current_stage).toBe(4);
      expect(after.status).toBe('running');
      const chunks = await repo.listChunks(pipeline.id);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].status).toBe('running');
    });

    it('pauses on stage 5 when gated, then routes to fix cycle on approval if QA failed', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      deps.readStageOutput = vi.fn().mockReturnValue('Overall: fail\n');
      orchestrator = orchestratorMod.create(deps);

      // Gate only stage 5; let stages 1-3 auto-advance.
      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID,
        name: 'Gate QA',
        specInput: 's',
        gatedStages: [5],
      });
      for (const stage of [1, 2, 3]) {
        await orchestrator.handleSessionComplete({
          sessionId: 'sess_mock',
          pipelineId: pipeline.id,
          pipelineStage: stage,
        });
      }
      // Stage 4 chunk completes.
      const chunkSessionId = (await repo.listChunks(pipeline.id))[0].session_id;
      await orchestrator.handleSessionComplete({
        sessionId: chunkSessionId,
        pipelineId: pipeline.id,
        pipelineStage: 4,
      });

      // Stage 5 finishes → should pause (gated) instead of auto-routing.
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_qa',
        pipelineId: pipeline.id,
        pipelineStage: 5,
      });
      let after = await repo.getPipeline(pipeline.id);
      expect(after.status).toBe('paused_for_approval');
      expect(after.current_stage).toBe(5);

      // On approval, the pipeline should still honor the QA verdict — fail → fix cycle.
      await orchestrator.approveCurrentStage(pipeline.id);
      after = await repo.getPipeline(pipeline.id);
      expect(after.current_stage).toBe(7);
      expect(after.fix_cycle_count).toBe(1);
    });

    it('pauses on stage 6 when gated, then completes on approval if blockers are zero', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      deps.readStageOutput = vi.fn()
        .mockReturnValueOnce('Overall: pass\n')      // stage 5 auto-routes
        .mockReturnValueOnce('Blockers: 0\n');       // stage 6 approval reads
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID,
        name: 'Gate review',
        specInput: 's',
        gatedStages: [6],
      });
      for (const stage of [1, 2, 3]) {
        await orchestrator.handleSessionComplete({
          sessionId: 'sess_mock',
          pipelineId: pipeline.id,
          pipelineStage: stage,
        });
      }
      const chunkSessionId = (await repo.listChunks(pipeline.id))[0].session_id;
      await orchestrator.handleSessionComplete({
        sessionId: chunkSessionId,
        pipelineId: pipeline.id,
        pipelineStage: 4,
      });
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_qa',
        pipelineId: pipeline.id,
        pipelineStage: 5,
      });
      // Stage 6 finishes → paused for approval.
      await orchestrator.handleSessionComplete({
        sessionId: 'sess_review',
        pipelineId: pipeline.id,
        pipelineStage: 6,
      });
      let after = await repo.getPipeline(pipeline.id);
      expect(after.status).toBe('paused_for_approval');
      expect(after.current_stage).toBe(6);

      await orchestrator.approveCurrentStage(pipeline.id);
      after = await repo.getPipeline(pipeline.id);
      expect(after.status).toBe('completed');
    });
  });

  describe('parseQaOverall / parseReviewBlockers', () => {
    it('parses pass and fail from the trailing line', () => {
      const { _parseQaOverall } = orchestratorMod;
      expect(_parseQaOverall('Overall: pass\n')).toBe('pass');
      expect(_parseQaOverall('Stuff\n\nOverall: fail')).toBe('fail');
      expect(_parseQaOverall('Overall: PASS')).toBe('pass');
    });

    it('returns fail when no marker is present', () => {
      const { _parseQaOverall } = orchestratorMod;
      expect(_parseQaOverall('No marker here.')).toBe('fail');
    });

    it('returns the integer for blockers count', () => {
      const { _parseReviewBlockers } = orchestratorMod;
      expect(_parseReviewBlockers('Blockers: 0')).toBe(0);
      expect(_parseReviewBlockers('Stuff\n\nBlockers: 5')).toBe(5);
    });

    it('returns a large fallback when no marker is present', () => {
      const { _parseReviewBlockers } = orchestratorMod;
      expect(_parseReviewBlockers('No marker here.')).toBeGreaterThan(0);
    });
  });

  describe('session close behavior', () => {
    const VALID_BUILD_PLAN = [
      '## Chunk 1: only',
      '- Files: a.js',
      '- QA Scenarios: a',
      '- Dependencies: none',
      '- Complexity: small',
      '',
      'body',
    ].join('\n');

    async function getSessionStatus(sessionId) {
      const r = await query('SELECT status FROM sessions WHERE id = $1', [sessionId]);
      return r.rows[0]?.status || null;
    }

    it('does NOT close the session when a gated stage completes (paused for approval)', async () => {
      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID, name: 'Gated keep-open', specInput: 's',
      });
      const stage1SessionId = deps.startSession.mock.results[0].value
        ? (await deps.startSession.mock.results[0].value).sessionId
        : null;

      await orchestrator.handleSessionComplete({
        sessionId: stage1SessionId, pipelineId: pipeline.id, pipelineStage: 1,
      });

      const updated = await repo.getPipeline(pipeline.id);
      expect(updated.status).toBe('paused_for_approval');
      expect(deps.endSession).not.toHaveBeenCalledWith(stage1SessionId);
      expect(await getSessionStatus(stage1SessionId)).toBe('idle');
    });

    it('closes the gated session when the stage is approved', async () => {
      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID, name: 'Gated approve', specInput: 's',
      });
      const stage1SessionId = (await deps.startSession.mock.results[0].value).sessionId;

      await orchestrator.handleSessionComplete({
        sessionId: stage1SessionId, pipelineId: pipeline.id, pipelineStage: 1,
      });
      expect(await getSessionStatus(stage1SessionId)).toBe('idle');

      await orchestrator.approveCurrentStage(pipeline.id);

      expect(deps.endSession).toHaveBeenCalledWith(stage1SessionId);
      expect(await getSessionStatus(stage1SessionId)).toBe('ended');
    });

    it('closes the gated session when the stage is rejected', async () => {
      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID, name: 'Gated reject', specInput: 's',
      });
      const stage1SessionId = (await deps.startSession.mock.results[0].value).sessionId;

      await orchestrator.handleSessionComplete({
        sessionId: stage1SessionId, pipelineId: pipeline.id, pipelineStage: 1,
      });

      await orchestrator.rejectCurrentStage(pipeline.id, 'Try again with more detail.');

      expect(deps.endSession).toHaveBeenCalledWith(stage1SessionId);
      expect(await getSessionStatus(stage1SessionId)).toBe('ended');
    });

    it('closes the chunk session when an implementation chunk completes', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID, name: 'Chunk close', specInput: 's',
      });
      // Walk through stages 1-3 with approvals.
      for (const stage of [1, 2, 3]) {
        const sessId = (await deps.startSession.mock.results[deps.startSession.mock.results.length - 1].value).sessionId;
        await orchestrator.handleSessionComplete({
          sessionId: sessId, pipelineId: pipeline.id, pipelineStage: stage,
        });
        if (stage < 3) await orchestrator.approveCurrentStage(pipeline.id);
      }
      await orchestrator.approveCurrentStage(pipeline.id); // stage 3 approval → start stage 4

      const chunkSessionId = (await repo.listChunks(pipeline.id))[0].session_id;
      expect(await getSessionStatus(chunkSessionId)).toBe('idle');

      await orchestrator.handleSessionComplete({
        sessionId: chunkSessionId, pipelineId: pipeline.id, pipelineStage: 4,
      });

      expect(deps.endSession).toHaveBeenCalledWith(chunkSessionId);
      expect(await getSessionStatus(chunkSessionId)).toBe('ended');
    });

    it('closes the QA session when stage 5 completes (non-gated)', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      deps.readStageOutput = vi.fn().mockReturnValue('Overall: pass\n');
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID, name: 'QA close', specInput: 's',
      });
      for (const stage of [1, 2, 3]) {
        const sessId = (await deps.startSession.mock.results[deps.startSession.mock.results.length - 1].value).sessionId;
        await orchestrator.handleSessionComplete({
          sessionId: sessId, pipelineId: pipeline.id, pipelineStage: stage,
        });
        if (stage < 3) await orchestrator.approveCurrentStage(pipeline.id);
      }
      await orchestrator.approveCurrentStage(pipeline.id);
      // Complete the only chunk → starts stage 5
      const chunkSessionId = (await repo.listChunks(pipeline.id))[0].session_id;
      await orchestrator.handleSessionComplete({
        sessionId: chunkSessionId, pipelineId: pipeline.id, pipelineStage: 4,
      });

      const qaSessionId = await repo.findActiveSessionForStage(pipeline.id, 5);
      expect(qaSessionId).toBeTruthy();
      expect(await getSessionStatus(qaSessionId)).toBe('idle');

      await orchestrator.handleSessionComplete({
        sessionId: qaSessionId, pipelineId: pipeline.id, pipelineStage: 5,
      });

      expect(deps.endSession).toHaveBeenCalledWith(qaSessionId);
      expect(await getSessionStatus(qaSessionId)).toBe('ended');
    });

    it('closes the fix-cycle session when stage 7 completes', async () => {
      deps.readBuildPlan = vi.fn().mockReturnValue(VALID_BUILD_PLAN);
      deps.readStageOutput = vi.fn().mockReturnValue('Overall: fail\n');
      orchestrator = orchestratorMod.create(deps);

      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID, name: 'Fix close', specInput: 's',
      });
      for (const stage of [1, 2, 3]) {
        const sessId = (await deps.startSession.mock.results[deps.startSession.mock.results.length - 1].value).sessionId;
        await orchestrator.handleSessionComplete({
          sessionId: sessId, pipelineId: pipeline.id, pipelineStage: stage,
        });
        if (stage < 3) await orchestrator.approveCurrentStage(pipeline.id);
      }
      await orchestrator.approveCurrentStage(pipeline.id);
      const chunkSessionId = (await repo.listChunks(pipeline.id))[0].session_id;
      await orchestrator.handleSessionComplete({
        sessionId: chunkSessionId, pipelineId: pipeline.id, pipelineStage: 4,
      });
      // Stage 5 fails → spawns stage 7 (fix cycle)
      const qaSessionId = await repo.findActiveSessionForStage(pipeline.id, 5);
      await orchestrator.handleSessionComplete({
        sessionId: qaSessionId, pipelineId: pipeline.id, pipelineStage: 5,
      });

      const fixSessionId = await repo.findActiveSessionForStage(pipeline.id, 7);
      expect(fixSessionId).toBeTruthy();

      await orchestrator.handleSessionComplete({
        sessionId: fixSessionId, pipelineId: pipeline.id, pipelineStage: 7,
      });

      expect(deps.endSession).toHaveBeenCalledWith(fixSessionId);
      expect(await getSessionStatus(fixSessionId)).toBe('ended');
    });

    it('closes the session when an output file is missing twice (escalation path)', async () => {
      deps.readFileExists.mockReturnValue(false);
      const pipeline = await orchestrator.createAndStart({
        projectId: TEST_PROJECT_ID, name: 'Missing file close', specInput: 's',
      });
      const firstSessionId = (await deps.startSession.mock.results[0].value).sessionId;

      // First failure → close + retry
      await orchestrator.handleSessionComplete({
        sessionId: firstSessionId, pipelineId: pipeline.id, pipelineStage: 1,
      });
      expect(deps.endSession).toHaveBeenCalledWith(firstSessionId);
      expect(await getSessionStatus(firstSessionId)).toBe('ended');

      // The retry spawned a new session — second failure escalates.
      const retrySessionId = (await deps.startSession.mock.results[deps.startSession.mock.results.length - 1].value).sessionId;
      await orchestrator.handleSessionComplete({
        sessionId: retrySessionId, pipelineId: pipeline.id, pipelineStage: 1,
      });

      expect(deps.endSession).toHaveBeenCalledWith(retrySessionId);
      expect(await getSessionStatus(retrySessionId)).toBe('ended');
      const final = await repo.getPipeline(pipeline.id);
      expect(final.status).toBe('paused_for_failure');
    });
  });
});
