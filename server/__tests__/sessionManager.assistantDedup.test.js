import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Test the assistant message dedup logic in isolation.
 *
 * The bug: Claude CLI emits an 'assistant' event for every content block update
 * within a single turn. Each event has the full message (all blocks so far).
 * The old code did INSERT for every event → N duplicate rows per turn.
 *
 * The fix: INSERT on first event, UPDATE on subsequent events. Reset on tool_result.
 */

// Replicate the core dedup logic from _processStreamEventAsync
const mockQuery = vi.fn();

async function processAssistant(session, event) {
  if (event.type !== 'assistant' || !event.message) return;

  let content;
  if (typeof event.message === 'string') {
    content = event.message;
  } else if (event.message.content && Array.isArray(event.message.content)) {
    content = event.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }

  if (!content) return;

  if (session._currentAssistantMsgId) {
    await mockQuery(
      `UPDATE messages SET content = $1, timestamp = NOW() WHERE id = $2`,
      [content, session._currentAssistantMsgId]
    );
  } else {
    const result = await mockQuery(
      `INSERT INTO messages (session_id, role, content, timestamp) VALUES ($1, 'assistant', $2, NOW()) RETURNING id`,
      [session.id, content]
    );
    session._currentAssistantMsgId = result.rows[0]?.id;
  }
}

function processToolResult(session) {
  session._currentAssistantMsgId = null;
}

function makeSession() {
  return {
    id: 'test-session-123',
    _currentAssistantMsgId: null,
    _processedToolUseIds: new Set(),
  };
}

describe('Assistant message deduplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts on first assistant event and updates on subsequent ones', async () => {
    const session = makeSession();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    // Event 1: assistant with text block only
    await processAssistant(session, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Let me check...' }] },
    });
    expect(session._currentAssistantMsgId).toBe(42);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain('INSERT');

    // Event 2: same text + tool_use block added (text unchanged)
    await processAssistant(session, {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check...' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
        ],
      },
    });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toContain('UPDATE');

    // Event 3: another tool_use block added (text still unchanged)
    await processAssistant(session, {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check...' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
          { type: 'tool_use', id: 'tu2', name: 'Grep', input: {} },
        ],
      },
    });
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery.mock.calls[2][0]).toContain('UPDATE');
  });

  it('resets turn after tool_result so next assistant inserts new row', async () => {
    const session = makeSession();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 43 }], rowCount: 1 });

    // First turn
    await processAssistant(session, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Let me check...' }] },
    });
    expect(session._currentAssistantMsgId).toBe(42);

    // tool_result resets the turn
    processToolResult(session);
    expect(session._currentAssistantMsgId).toBeNull();

    // Second turn — new assistant message should INSERT
    await processAssistant(session, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Here is what I found.' }] },
    });
    expect(session._currentAssistantMsgId).toBe(43);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0]).toContain('INSERT');
    expect(mockQuery.mock.calls[1][0]).toContain('INSERT');
  });

  it('sendMessage resets the turn tracker for the next response', () => {
    const session = makeSession();
    session._currentAssistantMsgId = 42;
    session._processedToolUseIds.add('tu1');

    // Simulate what sendMessage does
    session._currentAssistantMsgId = null;
    session._processedToolUseIds = new Set();

    expect(session._currentAssistantMsgId).toBeNull();
    expect(session._processedToolUseIds.size).toBe(0);
  });

  it('handles string messages correctly', async () => {
    const session = makeSession();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 50 }], rowCount: 1 });

    await processAssistant(session, {
      type: 'assistant',
      message: 'Simple string message',
    });
    expect(session._currentAssistantMsgId).toBe(50);
    expect(mockQuery.mock.calls[0][1]).toEqual(['test-session-123', 'Simple string message']);
  });

  it('skips events with no text content', async () => {
    const session = makeSession();

    // Message with only tool_use blocks (no text) — should be skipped
    await processAssistant(session, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }],
      },
    });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(session._currentAssistantMsgId).toBeNull();
  });
});
