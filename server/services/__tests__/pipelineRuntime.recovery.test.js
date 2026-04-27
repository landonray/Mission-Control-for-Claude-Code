import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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

const TEST_PROJECT_ID = `test-recovery-${crypto.randomBytes(4).toString('hex')}`;
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-recovery-'));

let query, initializeDb, repo, runtime;

async function makePipeline({ status = 'running', currentStage = 1 } = {}) {
  const id = `pipe_${crypto.randomBytes(8).toString('hex')}`;
  await query(
    `INSERT INTO pipelines (id, name, project_id, branch_name, status, current_stage, spec_input)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, `recovery test ${id}`, TEST_PROJECT_ID, `pipeline-${id}`, status, currentStage, 'spec']
  );
  return id;
}

async function makeWorkingSession({ pipelineId, stage, tmuxName = null }) {
  const id = `sess-${crypto.randomBytes(6).toString('hex')}`;
  await query(
    `INSERT INTO sessions (id, name, status, pipeline_id, pipeline_stage, tmux_session_name)
     VALUES ($1, $2, 'working', $3, $4, $5)`,
    [id, `recovery test session ${id}`, pipelineId, stage, tmuxName]
  );
  return id;
}

async function getSessionStatus(id) {
  const r = await query('SELECT status, ended_at FROM sessions WHERE id = $1', [id]);
  return r.rows[0];
}

beforeAll(async () => {
  ({ query, initializeDb } = require('../../database'));
  repo = require('../pipelineRepo');
  runtime = require('../pipelineRuntime');
  await initializeDb();
  await query(
    `INSERT INTO projects (id, name, root_path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [TEST_PROJECT_ID, 'recovery test project', TEST_ROOT]
  );
});

beforeEach(async () => {
  await query(`DELETE FROM sessions WHERE pipeline_id IN (SELECT id FROM pipelines WHERE project_id = $1)`, [TEST_PROJECT_ID]);
  await query(`DELETE FROM pipelines WHERE project_id = $1`, [TEST_PROJECT_ID]);
});

function makeFakeOrchestrator() {
  const calls = [];
  return {
    calls,
    handleSessionComplete: async (payload) => {
      calls.push(payload);
    },
  };
}

describe('reconcileStuckSessions', () => {
  it('returns empty when the requested pipeline has no stuck sessions', async () => {
    const pipelineId = await makePipeline();
    // Pipeline exists but no working sessions attached.
    const result = await runtime.reconcileStuckSessions({
      pipelineId,
      orchestrator: makeFakeOrchestrator(),
      isTmuxRunning: () => false,
      broadcast: () => {},
    });
    expect(result).toEqual([]);
  });

  it('does not touch sessions whose tmux is still alive', async () => {
    const pipelineId = await makePipeline();
    const sessionId = await makeWorkingSession({ pipelineId, stage: 1, tmuxName: 'mc-alive' });

    const orch = makeFakeOrchestrator();
    const result = await runtime.reconcileStuckSessions({
      pipelineId,
      orchestrator: orch,
      isTmuxRunning: (name) => name === 'mc-alive',
      broadcast: () => {},
    });

    expect(result).toEqual([]);
    expect(orch.calls).toEqual([]);
    const session = await getSessionStatus(sessionId);
    expect(session.status).toBe('working');
  });

  it('hands a stage-1 orphan back to the orchestrator and marks the session ended', async () => {
    const pipelineId = await makePipeline({ currentStage: 1 });
    const sessionId = await makeWorkingSession({ pipelineId, stage: 1, tmuxName: 'mc-dead' });

    const orch = makeFakeOrchestrator();
    const broadcasts = [];
    const result = await runtime.reconcileStuckSessions({
      pipelineId,
      orchestrator: orch,
      isTmuxRunning: () => false,
      broadcast: (id) => broadcasts.push(id),
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sessionId,
      pipelineId,
      stage: 1,
      action: 'recovered',
    });
    expect(orch.calls).toEqual([
      { sessionId, pipelineId, pipelineStage: 1 },
    ]);
    expect(broadcasts).toEqual([pipelineId]);

    const session = await getSessionStatus(sessionId);
    expect(session.status).toBe('ended');
    expect(session.ended_at).not.toBeNull();
  });

  it('pauses the pipeline and resets the chunk for an orphaned stage-4 session', async () => {
    const pipelineId = await makePipeline({ currentStage: 4 });
    const sessionId = await makeWorkingSession({ pipelineId, stage: 4, tmuxName: 'mc-dead' });
    await repo.createChunks(pipelineId, [
      { index: 0, name: 'chunk-zero', body: 'do work', files: '', qaScenarios: '', dependencies: '', complexity: '' },
    ]);
    await repo.markChunkRunning(pipelineId, 0, sessionId);

    const orch = makeFakeOrchestrator();
    const result = await runtime.reconcileStuckSessions({
      pipelineId,
      orchestrator: orch,
      isTmuxRunning: () => false,
      broadcast: () => {},
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sessionId, stage: 4, action: 'paused_chunk' });
    expect(orch.calls).toEqual([]); // stage 4 must not silently advance

    const refreshed = await repo.getPipeline(pipelineId);
    expect(refreshed.status).toBe('paused_for_failure');

    const chunks = await repo.listChunks(pipelineId);
    expect(chunks[0].status).toBe('pending');
    expect(chunks[0].session_id).toBeNull();

    const escalations = await repo.listOpenEscalations(pipelineId);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].stage).toBe(4);

    const session = await getSessionStatus(sessionId);
    expect(session.status).toBe('ended');
  });

  it('skips pipelines that are already completed or failed', async () => {
    const pipelineId = await makePipeline({ status: 'completed' });
    const sessionId = await makeWorkingSession({ pipelineId, stage: 1, tmuxName: 'mc-dead' });

    const orch = makeFakeOrchestrator();
    const result = await runtime.reconcileStuckSessions({
      pipelineId,
      orchestrator: orch,
      isTmuxRunning: () => false,
      broadcast: () => {},
    });

    expect(result).toEqual([]);
    expect(orch.calls).toEqual([]);
    const session = await getSessionStatus(sessionId);
    expect(session.status).toBe('working'); // untouched
  });

  it('only touches sessions for the requested pipeline when pipelineId is provided', async () => {
    const targetPipeline = await makePipeline();
    const otherPipeline = await makePipeline();
    const targetSession = await makeWorkingSession({ pipelineId: targetPipeline, stage: 1, tmuxName: 'mc-dead-1' });
    const otherSession = await makeWorkingSession({ pipelineId: otherPipeline, stage: 1, tmuxName: 'mc-dead-2' });

    const orch = makeFakeOrchestrator();
    const result = await runtime.reconcileStuckSessions({
      pipelineId: targetPipeline,
      orchestrator: orch,
      isTmuxRunning: () => false,
      broadcast: () => {},
    });

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe(targetSession);
    expect(orch.calls).toHaveLength(1);
    expect(orch.calls[0].sessionId).toBe(targetSession);

    const stillWorking = await getSessionStatus(otherSession);
    expect(stillWorking.status).toBe('working');
  });

  it('records the orchestrator error and continues to the next session on failure', async () => {
    const pipelineId = await makePipeline();
    const sessionId = await makeWorkingSession({ pipelineId, stage: 1, tmuxName: 'mc-dead' });

    const orch = {
      handleSessionComplete: async () => {
        throw new Error('boom');
      },
    };
    const result = await runtime.reconcileStuckSessions({
      pipelineId,
      orchestrator: orch,
      isTmuxRunning: () => false,
      broadcast: () => {},
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sessionId, action: 'error', error: 'boom' });
    const session = await getSessionStatus(sessionId);
    expect(session.status).toBe('ended');
  });
});
