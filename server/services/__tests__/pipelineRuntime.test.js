import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_URL ||= 'postgres://stub:stub@stub.invalid/stub';

const require = createRequire(import.meta.url);

let runtime, sessionManager;

beforeAll(() => {
  runtime = require('../pipelineRuntime');
  sessionManager = require('../sessionManager');
});

describe('pipelineRuntime', () => {
  it('exposes start() and getOrchestrator()', () => {
    expect(typeof runtime.start).toBe('function');
    expect(typeof runtime.getOrchestrator).toBe('function');
  });

  it('start() returns an orchestrator with the expected public methods', () => {
    const { orchestrator } = runtime.start();
    expect(typeof orchestrator.createAndStart).toBe('function');
    expect(typeof orchestrator.handleSessionComplete).toBe('function');
    expect(typeof orchestrator.approveCurrentStage).toBe('function');
    expect(typeof orchestrator.rejectCurrentStage).toBe('function');
  });

  it('getOrchestrator() returns the same orchestrator after start()', () => {
    runtime.start();
    const orch1 = runtime.getOrchestrator();
    const orch2 = runtime.getOrchestrator();
    expect(orch1).toBe(orch2);
  });

  it('start() is idempotent — multiple calls return the same orchestrator', () => {
    const r1 = runtime.start();
    const r2 = runtime.start();
    expect(r1.orchestrator).toBe(r2.orchestrator);
  });

  it('registers exactly one session_complete listener on globalEvents', () => {
    const before = sessionManager.globalEvents.listenerCount('session_complete');
    runtime.start();
    runtime.start();
    runtime.start();
    const after = sessionManager.globalEvents.listenerCount('session_complete');
    // At most one new listener should have been added across multiple start() calls.
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it('the registered listener ignores events with no pipelineId', async () => {
    const { orchestrator } = runtime.start();
    let called = false;
    const original = orchestrator.handleSessionComplete;
    orchestrator.handleSessionComplete = async () => { called = true; };
    sessionManager.globalEvents.emit('session_complete', { sessionId: 's', pipelineId: null, pipelineStage: null });
    await new Promise((r) => setImmediate(r));
    expect(called).toBe(false);
    orchestrator.handleSessionComplete = original;
  });

  it('the registered listener forwards events with pipelineId to the orchestrator', async () => {
    const { orchestrator } = runtime.start();
    const received = [];
    const original = orchestrator.handleSessionComplete;
    orchestrator.handleSessionComplete = async (payload) => { received.push(payload); };
    sessionManager.globalEvents.emit('session_complete', { sessionId: 's1', pipelineId: 'p1', pipelineStage: 1 });
    await new Promise((r) => setImmediate(r));
    expect(received).toEqual([{ sessionId: 's1', pipelineId: 'p1', pipelineStage: 1 }]);
    orchestrator.handleSessionComplete = original;
  });
});
