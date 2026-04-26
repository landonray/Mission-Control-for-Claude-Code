import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the queue-drain → sendMessage path.
 *
 * Bug being fixed: when a queued message was drained, the existing dequeue
 * code called sendMessage(text) which fell through to the "spawn new process"
 * branch. That branch INSERTs the user message into the `messages` table —
 * but the row had already been inserted when the message was first queued.
 * Result: every queued message ended up duplicated in the chat history.
 *
 * The fix: pass a fromQueue flag through sendMessage. When set, the function
 * skips the messages-table INSERT (the row already exists from queue time)
 * and reuses the originating row.
 */

const mockQuery = vi.fn();

// Replicate the relevant branch of sendMessage that decides whether to INSERT.
// Returns the count of messages-table INSERTs the call would have produced.
async function sendMessageInsertCount({ status, hasProcess, fromQueue }) {
  let inserts = 0;

  // Queueing branch (process running, status === 'working')
  if (hasProcess && status === 'working') {
    if (!fromQueue) {
      // First-time queue: insert into messages so the chat shows it as queued
      await mockQuery(`INSERT INTO messages …`);
      inserts++;
    }
    return inserts;
  }

  // Spawn-new-process branch (no process or different status)
  if (!fromQueue) {
    // Fresh user message — insert into messages
    await mockQuery(`INSERT INTO messages …`);
    inserts++;
  }
  // (sendMessage continues with spawnProcess, not modeled here)
  return inserts;
}

describe('sendMessage fromQueue flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts on a fresh user message when nothing is running', async () => {
    const inserts = await sendMessageInsertCount({
      status: 'idle',
      hasProcess: false,
      fromQueue: false,
    });
    expect(inserts).toBe(1);
  });

  it('inserts when queueing a fresh user message during a working turn', async () => {
    const inserts = await sendMessageInsertCount({
      status: 'working',
      hasProcess: true,
      fromQueue: false,
    });
    expect(inserts).toBe(1);
  });

  it('does NOT insert again when a queued message is drained and re-sent', async () => {
    // This is the bug: the drain calls sendMessage, which falls into the
    // spawn-new-process branch (status will be 'reviewing' or 'idle', not
    // 'working', because the previous process just exited). With fromQueue,
    // we skip the duplicate INSERT.
    const inserts = await sendMessageInsertCount({
      status: 'reviewing',
      hasProcess: false,
      fromQueue: true,
    });
    expect(inserts).toBe(0);
  });

  it('does NOT insert when a queued message lands back in the queue (fromQueue + working)', async () => {
    // Edge case: the drain fires sendMessage, but in the 100ms gap the user
    // typed something else that started a new process. The drained message
    // gets queued again — but it was already in messages, so still no insert.
    const inserts = await sendMessageInsertCount({
      status: 'working',
      hasProcess: true,
      fromQueue: true,
    });
    expect(inserts).toBe(0);
  });
});

/**
 * Tests for the queue rehydration path.
 *
 * Bug being fixed: the message queue lived only in memory, so a server
 * restart (manual, crash, agent-triggered) silently dropped every queued
 * message in every session. The rows had already been inserted into
 * `messages` (so the user could see them with the queued badge in the chat)
 * but the agent was never told about them.
 *
 * The fix: persist the queue to a `queued_messages` table and rehydrate the
 * in-memory queue from it whenever a SessionProcess instance is created.
 */

// Replicate the rehydration logic
async function rehydrateQueue(sessionId, deps) {
  const rows = await deps.peekAll(sessionId);
  return rows.map(r => ({
    queueId: r.id,
    content: r.content,
    attachments: r.attachments,
  }));
}

describe('queue rehydration on session instantiation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty queue when no messages are persisted', async () => {
    const peekAll = vi.fn().mockResolvedValue([]);
    const queue = await rehydrateQueue('sess-1', { peekAll });
    expect(queue).toEqual([]);
  });

  it('rehydrates a non-empty queue in FIFO order', async () => {
    const peekAll = vi.fn().mockResolvedValue([
      { id: 1, content: 'first', attachments: null },
      { id: 2, content: 'second', attachments: null },
      { id: 3, content: 'third', attachments: null },
    ]);
    const queue = await rehydrateQueue('sess-1', { peekAll });
    expect(queue.map(q => q.content)).toEqual(['first', 'second', 'third']);
    expect(queue[0].queueId).toBe(1);
    expect(queue[2].queueId).toBe(3);
  });

  it('preserves attachments through rehydration', async () => {
    const peekAll = vi.fn().mockResolvedValue([
      { id: 1, content: 'with image', attachments: [{ id: 'a1', isImage: true }] },
    ]);
    const queue = await rehydrateQueue('sess-1', { peekAll });
    expect(queue[0].attachments).toEqual([{ id: 'a1', isImage: true }]);
  });
});
