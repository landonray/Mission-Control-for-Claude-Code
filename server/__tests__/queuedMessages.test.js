import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  enqueue,
  dequeue,
  peekAll,
  removeById,
  clearForSession,
} from '../services/queuedMessages.js';

function makeFakeQuery(responses) {
  const queue = [...responses];
  const fn = vi.fn(async () => {
    const next = queue.shift();
    if (!next) return { rows: [], rowCount: 0 };
    if (Array.isArray(next)) return { rows: next, rowCount: next.length };
    return next;
  });
  return fn;
}

describe('queuedMessages.enqueue', () => {
  it('inserts a row and returns the new id', async () => {
    const query = makeFakeQuery([[{ id: 17 }]]);
    const result = await enqueue('sess-1', 'hello', null, { query });
    expect(result).toEqual({ id: 17 });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO queued_messages/);
    expect(params).toEqual(['sess-1', 'hello', null]);
  });

  it('serializes attachments as JSON when present', async () => {
    const query = makeFakeQuery([[{ id: 18 }]]);
    const attachments = [{ id: 'a1', isImage: true }];
    await enqueue('sess-1', 'hi', attachments, { query });
    const [, params] = query.mock.calls[0];
    expect(params[2]).toBe(JSON.stringify(attachments));
  });
});

describe('queuedMessages.dequeue', () => {
  it('returns null when no rows are queued for the session', async () => {
    const query = makeFakeQuery([{ rows: [], rowCount: 0 }]);
    const result = await dequeue('sess-1', { query });
    expect(result).toBeNull();
  });

  it('returns the oldest row and deletes it atomically (DELETE … RETURNING)', async () => {
    const row = { id: 99, content: 'oldest msg', attachments: null };
    const query = makeFakeQuery([{ rows: [row], rowCount: 1 }]);
    const result = await dequeue('sess-1', { query });
    expect(result).toEqual({ id: 99, content: 'oldest msg', attachments: null });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql] = query.mock.calls[0];
    // single round-trip: DELETE … RETURNING via a sub-select
    expect(sql).toMatch(/DELETE FROM queued_messages/);
    expect(sql).toMatch(/RETURNING/);
  });

  it('parses attachments JSON when present in the deleted row', async () => {
    const stored = JSON.stringify([{ id: 'a1' }]);
    const query = makeFakeQuery([
      { rows: [{ id: 99, content: 'hi', attachments: stored }], rowCount: 1 },
    ]);
    const result = await dequeue('sess-1', { query });
    expect(result.attachments).toEqual([{ id: 'a1' }]);
  });
});

describe('queuedMessages.peekAll', () => {
  it('returns rows in FIFO order (oldest first)', async () => {
    const rows = [
      { id: 1, content: 'first', attachments: null },
      { id: 2, content: 'second', attachments: null },
    ];
    const query = makeFakeQuery([rows]);
    const result = await peekAll('sess-1', { query });
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('first');
    expect(result[1].content).toBe('second');
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/ORDER BY id ASC/);
  });

  it('parses attachments JSON for each row', async () => {
    const rows = [
      { id: 1, content: 'a', attachments: JSON.stringify([{ id: 'x' }]) },
      { id: 2, content: 'b', attachments: null },
    ];
    const query = makeFakeQuery([rows]);
    const result = await peekAll('sess-1', { query });
    expect(result[0].attachments).toEqual([{ id: 'x' }]);
    expect(result[1].attachments).toBeNull();
  });
});

describe('queuedMessages.removeById', () => {
  it('returns true when the row is deleted', async () => {
    const query = makeFakeQuery([{ rows: [], rowCount: 1 }]);
    const result = await removeById(42, { query });
    expect(result).toBe(true);
    expect(query.mock.calls[0][0]).toMatch(/DELETE FROM queued_messages/);
    expect(query.mock.calls[0][1]).toEqual([42]);
  });

  it('returns false when no row matched', async () => {
    const query = makeFakeQuery([{ rows: [], rowCount: 0 }]);
    const result = await removeById(42, { query });
    expect(result).toBe(false);
  });
});

describe('queuedMessages.clearForSession', () => {
  it('deletes all rows for the given session', async () => {
    const query = makeFakeQuery([{ rows: [], rowCount: 3 }]);
    await clearForSession('sess-1', { query });
    expect(query.mock.calls[0][0]).toMatch(/DELETE FROM queued_messages WHERE session_id/);
    expect(query.mock.calls[0][1]).toEqual(['sess-1']);
  });
});
