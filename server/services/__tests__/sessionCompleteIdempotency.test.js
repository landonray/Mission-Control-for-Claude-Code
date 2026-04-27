import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_URL ||= 'postgres://stub:stub@stub.invalid/stub';

const require = createRequire(import.meta.url);

let sessionManager;

beforeAll(() => {
  sessionManager = require('../sessionManager');
});

describe('SessionProcess.handleTmuxProcessExit idempotency', () => {
  // Background: stage-7 (fix-cycle) pipeline sessions are typed `implementation`,
  // which means they run the post-session quality-review loop. A failing quality
  // rule sends the agent back to work via sendMessage(), which respawns the agent
  // inside the same session. When that respawn finishes, handleTmuxProcessExit
  // fires again. Without the guard, every fire emits a new `session_complete`
  // event, so the pipeline orchestrator spawns a duplicate stage-5 QA session
  // for each iteration. The guard ensures at most one session_complete per
  // session lifecycle.

  function makeSession(id = 'test-session-id') {
    const s = new sessionManager.SessionProcess(id, { workingDirectory: '/tmp' });
    // skipQualityChecks=true short-circuits the quality runner so the test
    // doesn't depend on qualityRunner / DB writes triggered by transitionToIdle.
    s.skipQualityChecks = true;
    s.status = 'idle';
    // Stub broadcast so we don't need a real WebSocket subscriber.
    s.broadcast = () => {};
    s.transitionToIdle = () => {};
    s.updateDbStatus = () => {};
    s._drainQueue = () => {};
    return s;
  }

  it('sets the _sessionCompleteEmitted guard on the first call', () => {
    const s = makeSession('sess-first');
    expect(s._sessionCompleteEmitted).toBeFalsy();
    s.handleTmuxProcessExit();
    expect(s._sessionCompleteEmitted).toBe(true);
  });

  it('does not re-enter the emit branch on subsequent calls', () => {
    const s = makeSession('sess-repeat');
    // Pre-set the flag to simulate a session that has already emitted once.
    s._sessionCompleteEmitted = true;

    // Spy on globalEvents.emit to confirm no session_complete is queued for this
    // session. Other emits (e.g. broadcasts) are not relevant here, so we filter
    // by event name.
    const emitSpy = vi.spyOn(sessionManager.globalEvents, 'emit');

    s.handleTmuxProcessExit();

    // Drain microtasks so any (incorrectly) queued .then would run.
    return Promise.resolve().then(() => {
      const sessionCompleteCalls = emitSpy.mock.calls.filter(
        (args) => args[0] === 'session_complete'
      );
      expect(sessionCompleteCalls).toHaveLength(0);
      emitSpy.mockRestore();
    });
  });

  it('keeps the guard set across multiple calls (idempotent)', () => {
    const s = makeSession('sess-multi');
    s.handleTmuxProcessExit();
    s.handleTmuxProcessExit();
    s.handleTmuxProcessExit();
    expect(s._sessionCompleteEmitted).toBe(true);
  });
});
