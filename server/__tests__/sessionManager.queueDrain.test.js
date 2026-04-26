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

// Replicate the relevant branch of sendMessage. Mirrors the real method's
// decision tree for: (a) whether to INSERT into messages, and (b) whether to
// re-enqueue when a drained message arrives during a fresh working turn.
async function callSendMessage(session, { status, hasProcess, fromQueue, content = 'msg' }) {
  let inserts = 0;

  // Queueing branch (process running, status === 'working')
  if (hasProcess && status === 'working') {
    if (fromQueue) {
      // Race: the drain shifted us out of the queue and removed the persisted
      // row, but a brand-new process started in the 100ms gap. Re-persist and
      // re-push so the message isn't silently lost. No messages-table INSERT
      // (the chat row already exists from the original queue).
      const persisted = await session.queuedMessages.enqueue(session.id, content);
      session.messageQueue.push({ content, attachments: null, queueId: persisted.id });
      return { inserts };
    }
    // First-time queue: insert into messages so the chat shows it as queued
    await mockQuery(`INSERT INTO messages …`);
    inserts++;
    return { inserts };
  }

  // Spawn-new-process branch (no process or different status)
  if (!fromQueue) {
    await mockQuery(`INSERT INTO messages …`);
    inserts++;
  }
  return { inserts };
}

function makeSession() {
  return {
    id: 'sess-1',
    messageQueue: [],
    queuedMessages: { enqueue: vi.fn().mockResolvedValue({ id: 999 }) },
  };
}

describe('sendMessage fromQueue flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts on a fresh user message when nothing is running', async () => {
    const session = makeSession();
    const { inserts } = await callSendMessage(session, {
      status: 'idle',
      hasProcess: false,
      fromQueue: false,
    });
    expect(inserts).toBe(1);
  });

  it('inserts when queueing a fresh user message during a working turn', async () => {
    const session = makeSession();
    const { inserts } = await callSendMessage(session, {
      status: 'working',
      hasProcess: true,
      fromQueue: false,
    });
    expect(inserts).toBe(1);
  });

  it('does NOT insert again when a queued message is drained and re-sent', async () => {
    // The drain calls sendMessage; the previous process just exited, so status
    // is 'reviewing' or 'idle'. With fromQueue we skip the duplicate INSERT
    // — the chat row already exists from when the message was first queued.
    const session = makeSession();
    const { inserts } = await callSendMessage(session, {
      status: 'reviewing',
      hasProcess: false,
      fromQueue: true,
    });
    expect(inserts).toBe(0);
  });

  it('re-enqueues without inserting when a drained message lands during a fresh working turn', async () => {
    // Race: in the 100ms between dequeue broadcast and the deferred sendMessage
    // call, a brand-new process started (because the user typed something else).
    // The drained message must be re-persisted AND re-pushed onto the in-memory
    // queue — both copies were already removed by _drainQueue, so a bare early
    // return would silently drop the message.
    const session = makeSession();
    const { inserts } = await callSendMessage(session, {
      status: 'working',
      hasProcess: true,
      fromQueue: true,
      content: 'drained-then-requeued',
    });
    expect(inserts).toBe(0);
    // Re-persisted: enqueue called with the message
    expect(session.queuedMessages.enqueue).toHaveBeenCalledWith('sess-1', 'drained-then-requeued');
    // Re-pushed: the in-memory queue now holds the message with the new persisted id
    expect(session.messageQueue).toHaveLength(1);
    expect(session.messageQueue[0]).toMatchObject({
      content: 'drained-then-requeued',
      queueId: 999,
    });
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
