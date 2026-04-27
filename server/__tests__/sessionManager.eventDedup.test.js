import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The bug: when the backend server restarts while a Claude session is mid-flight,
 * the recovered tail used to start reading from the END of the JSONL output file,
 * silently dropping any output already written by Claude. The fix: tail always
 * reads from the START of the file, with an in-memory set of already-seen event
 * UUIDs (seeded from the DB on recovery) preventing duplicate inserts.
 *
 * This test exercises the dedup logic in isolation — it doesn't spin up a real
 * SessionProcess, just verifies that:
 *   1. processStreamEvent skips events whose UUID is in _seenEventUuids
 *   2. _seedDedupStateFromDb hydrates _seenEventUuids from stream_events rows
 *   3. _seedDedupStateFromDb seeds _currentAssistantCliMsgId/_currentAssistantMsgId
 *      so subsequent events for the same CLI message UPDATE instead of INSERT
 */

const mockQuery = vi.fn();

// A minimal subset of processStreamEvent that mirrors the real dedup gate
function processStreamEvent(session, event) {
  if (event.uuid && session._seenEventUuids.has(event.uuid)) {
    return false; // skipped
  }
  if (
    event.type === 'tool_use' || event.type === 'tool_result' ||
    event.type === 'assistant' || event.type === 'user' ||
    event.type === 'system' || event.type === 'result'
  ) {
    if (event.uuid) session._seenEventUuids.add(event.uuid);
    mockQuery(
      `INSERT INTO stream_events (session_id, event_type, event_data, timestamp) VALUES ($1, $2, $3, NOW())`,
      [session.id, event.type, JSON.stringify(event)]
    );
    return true;
  }
  return false;
}

async function seedDedupStateFromDb(session, dbRows) {
  let lastAssistantCliMsgId = null;
  let lastAssistantContent = null;
  for (const row of dbRows) {
    let ev;
    try {
      ev = typeof row.event_data === 'string' ? JSON.parse(row.event_data) : row.event_data;
    } catch (_) { continue; }
    if (ev?.uuid) session._seenEventUuids.add(ev.uuid);
    if (ev?.type === 'assistant' && ev.message?.id) {
      lastAssistantCliMsgId = ev.message.id;
      if (Array.isArray(ev.message.content)) {
        const text = ev.message.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n');
        if (text) lastAssistantContent = text;
        for (const block of ev.message.content) {
          if (block.type === 'tool_use' && block.id) {
            session._processedToolUseIds.add(block.id);
          }
        }
      }
    }
  }
  if (lastAssistantCliMsgId && lastAssistantContent) {
    session._currentAssistantCliMsgId = lastAssistantCliMsgId;
    session._currentAssistantMsgId = 999;
  }
}

function makeSession() {
  return {
    id: 'test-session',
    _seenEventUuids: new Set(),
    _processedToolUseIds: new Set(),
    _currentAssistantCliMsgId: null,
    _currentAssistantMsgId: null,
  };
}

describe('Stream event UUID deduplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts events not yet seen and adds their UUID to the set', () => {
    const session = makeSession();
    const inserted = processStreamEvent(session, {
      type: 'assistant',
      uuid: 'event-1',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    expect(inserted).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(session._seenEventUuids.has('event-1')).toBe(true);
  });

  it('skips events whose UUID is already in the seen set', () => {
    const session = makeSession();
    session._seenEventUuids.add('event-1');
    const inserted = processStreamEvent(session, {
      type: 'assistant',
      uuid: 'event-1',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    expect(inserted).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('treats events without a uuid as always new (no dedup possible)', () => {
    const session = makeSession();
    processStreamEvent(session, { type: 'assistant', message: { content: [] } });
    processStreamEvent(session, { type: 'assistant', message: { content: [] } });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

describe('Seeding dedup state from DB on recovery', () => {
  it('populates _seenEventUuids from existing stream_events rows', async () => {
    const session = makeSession();
    await seedDedupStateFromDb(session, [
      { event_data: JSON.stringify({ type: 'system', uuid: 'a' }) },
      { event_data: JSON.stringify({ type: 'assistant', uuid: 'b', message: { content: [] } }) },
      { event_data: JSON.stringify({ type: 'user', uuid: 'c' }) },
    ]);
    expect(session._seenEventUuids.size).toBe(3);
    expect(session._seenEventUuids.has('a')).toBe(true);
    expect(session._seenEventUuids.has('b')).toBe(true);
    expect(session._seenEventUuids.has('c')).toBe(true);
  });

  it('skips rows with malformed JSON without throwing', async () => {
    const session = makeSession();
    await seedDedupStateFromDb(session, [
      { event_data: 'not-json' },
      { event_data: JSON.stringify({ type: 'system', uuid: 'a' }) },
    ]);
    expect(session._seenEventUuids.has('a')).toBe(true);
    expect(session._seenEventUuids.size).toBe(1);
  });

  it('seeds _currentAssistantCliMsgId from the latest assistant event', async () => {
    const session = makeSession();
    await seedDedupStateFromDb(session, [
      { event_data: JSON.stringify({
        type: 'assistant', uuid: 'a',
        message: { id: 'msg_first', content: [{ type: 'text', text: 'first' }] }
      }) },
      { event_data: JSON.stringify({
        type: 'assistant', uuid: 'b',
        message: { id: 'msg_second', content: [{ type: 'text', text: 'second' }] }
      }) },
    ]);
    expect(session._currentAssistantCliMsgId).toBe('msg_second');
    expect(session._currentAssistantMsgId).not.toBeNull();
  });

  it('seeds _processedToolUseIds from existing tool_use blocks', async () => {
    const session = makeSession();
    await seedDedupStateFromDb(session, [
      { event_data: JSON.stringify({
        type: 'assistant', uuid: 'a',
        message: { id: 'msg_1', content: [
          { type: 'text', text: 'using tool' },
          { type: 'tool_use', id: 'tu_1', name: 'Read' },
          { type: 'tool_use', id: 'tu_2', name: 'Grep' },
        ] }
      }) },
    ]);
    expect(session._processedToolUseIds.has('tu_1')).toBe(true);
    expect(session._processedToolUseIds.has('tu_2')).toBe(true);
  });
});

describe('Recovery scenario: re-tailing the JSONL file', () => {
  it('skips already-persisted events and inserts only new ones', async () => {
    const session = makeSession();

    // Simulate previous server's run: 3 events persisted to DB before the crash
    await seedDedupStateFromDb(session, [
      { event_data: JSON.stringify({ type: 'system', uuid: 'a' }) },
      { event_data: JSON.stringify({ type: 'assistant', uuid: 'b', message: { id: 'msg_1', content: [] } }) },
      { event_data: JSON.stringify({ type: 'user', uuid: 'c' }) },
    ]);

    vi.clearAllMocks();

    // Now the new server replays the JSONL file from the start (5 events total)
    const fileEvents = [
      { type: 'system', uuid: 'a' },                                                       // already in DB
      { type: 'assistant', uuid: 'b', message: { id: 'msg_1', content: [] } },             // already in DB
      { type: 'user', uuid: 'c' },                                                         // already in DB
      { type: 'assistant', uuid: 'd', message: { id: 'msg_2', content: [] } },             // NEW
      { type: 'result', uuid: 'e' },                                                       // NEW
    ];
    const insertedCount = fileEvents.filter(ev => processStreamEvent(session, ev)).length;
    expect(insertedCount).toBe(2);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
