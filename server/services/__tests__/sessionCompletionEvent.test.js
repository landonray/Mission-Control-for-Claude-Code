import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_URL ||= 'postgres://stub:stub@stub.invalid/stub';

const require = createRequire(import.meta.url);
let sessionManager;

beforeAll(() => {
  sessionManager = require('../sessionManager');
});

describe('sessionManager.globalEvents', () => {
  it('exposes an EventEmitter as globalEvents', () => {
    expect(sessionManager.globalEvents).toBeDefined();
    expect(typeof sessionManager.globalEvents.on).toBe('function');
    expect(typeof sessionManager.globalEvents.emit).toBe('function');
  });

  it('relays session_complete events to subscribers', () => {
    const received = [];
    const handler = (payload) => received.push(payload);
    sessionManager.globalEvents.on('session_complete', handler);

    sessionManager.globalEvents.emit('session_complete', {
      sessionId: 'sess_test',
      pipelineId: 'pipe_test',
      pipelineStage: 1,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      sessionId: 'sess_test',
      pipelineId: 'pipe_test',
      pipelineStage: 1,
    });

    sessionManager.globalEvents.off('session_complete', handler);
  });
});
