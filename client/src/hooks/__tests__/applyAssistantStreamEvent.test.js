import { describe, it, expect } from 'vitest';
import { applyAssistantStreamEvent, extractAssistantContent } from '../applyAssistantStreamEvent';

const tStart = '2026-04-25T10:00:00.000Z';
const tMid = '2026-04-25T10:00:01.000Z';
const tEnd = '2026-04-25T10:00:02.000Z';

function assistantEvent(id, text) {
  return {
    type: 'assistant',
    message: { id, content: [{ type: 'text', text }] }
  };
}

describe('extractAssistantContent', () => {
  it('joins text blocks with newlines', () => {
    const message = {
      id: 'msg_1',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
        { type: 'text', text: 'World' }
      ]
    };
    expect(extractAssistantContent(message)).toBe('Hello\nWorld');
  });

  it('returns string messages as-is', () => {
    expect(extractAssistantContent('plain text')).toBe('plain text');
  });

  it('returns empty string for null/undefined', () => {
    expect(extractAssistantContent(null)).toBe('');
    expect(extractAssistantContent(undefined)).toBe('');
  });
});

describe('applyAssistantStreamEvent — streaming updates', () => {
  it('appends a new assistant message when no prior message has the same id', () => {
    const next = applyAssistantStreamEvent([], assistantEvent('msg_1', 'Hi'), tStart);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      role: 'assistant',
      content: 'Hi',
      messageId: 'msg_1',
      timestamp: tStart
    });
  });

  it('updates content in place when a later event arrives with the same message id', () => {
    const after1 = applyAssistantStreamEvent([], assistantEvent('msg_1', 'Hi'), tStart);
    const after2 = applyAssistantStreamEvent(after1, assistantEvent('msg_1', 'Hi there'), tMid);
    const after3 = applyAssistantStreamEvent(after2, assistantEvent('msg_1', 'Hi there friend'), tEnd);

    expect(after3).toHaveLength(1);
    expect(after3[0].content).toBe('Hi there friend');
    expect(after3[0].messageId).toBe('msg_1');
    expect(after3[0].timestamp).toBe(tEnd);
  });

  it('returns a new array reference when content changes (so React re-renders)', () => {
    const after1 = applyAssistantStreamEvent([], assistantEvent('msg_1', 'Hi'), tStart);
    const after2 = applyAssistantStreamEvent(after1, assistantEvent('msg_1', 'Hi there'), tMid);
    expect(after2).not.toBe(after1);
    expect(after2[0]).not.toBe(after1[0]);
  });

  it('starts a new bubble when a different message id appears', () => {
    const after1 = applyAssistantStreamEvent([], assistantEvent('msg_1', 'First turn'), tStart);
    const after2 = applyAssistantStreamEvent(after1, assistantEvent('msg_2', 'Second turn'), tMid);

    expect(after2).toHaveLength(2);
    expect(after2[0].content).toBe('First turn');
    expect(after2[1].content).toBe('Second turn');
    expect(after2[1].messageId).toBe('msg_2');
  });

  it('preserves unrelated messages in the list', () => {
    const initial = [
      { role: 'user', content: 'hello', timestamp: tStart },
      { role: 'assistant', content: 'old turn', messageId: 'msg_old', timestamp: tStart }
    ];
    const after = applyAssistantStreamEvent(initial, assistantEvent('msg_new', 'new turn'), tMid);
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(initial[0]);
    expect(after[1]).toBe(initial[1]);
    expect(after[2].messageId).toBe('msg_new');
  });

  it('returns prev unchanged when content is empty', () => {
    const prev = [{ role: 'user', content: 'hi', timestamp: tStart }];
    const next = applyAssistantStreamEvent(prev, assistantEvent('msg_1', ''), tMid);
    expect(next).toBe(prev);
  });
});

describe('applyAssistantStreamEvent — DB-loaded message reconciliation', () => {
  it('claims a DB-loaded assistant message with matching content (no messageId yet)', () => {
    const prev = [
      { role: 'user', content: 'hi', timestamp: tStart },
      { role: 'assistant', content: 'previous answer', timestamp: tMid }
    ];
    const next = applyAssistantStreamEvent(prev, assistantEvent('msg_1', 'previous answer'), tEnd);

    expect(next).toHaveLength(2);
    expect(next[1].messageId).toBe('msg_1');
    expect(next[1].content).toBe('previous answer');
  });

  it('claims a DB-loaded message when the streamed content extends it', () => {
    const prev = [
      { role: 'assistant', content: 'partial', timestamp: tStart }
    ];
    const next = applyAssistantStreamEvent(prev, assistantEvent('msg_1', 'partial answer'), tMid);

    expect(next).toHaveLength(1);
    expect(next[0].messageId).toBe('msg_1');
    expect(next[0].content).toBe('partial answer');
  });

  it('does not claim DB-loaded messages that already have a messageId', () => {
    const prev = [
      { role: 'assistant', content: 'previous', messageId: 'msg_old', timestamp: tStart }
    ];
    const next = applyAssistantStreamEvent(prev, assistantEvent('msg_new', 'previous'), tMid);

    expect(next).toHaveLength(2);
    expect(next[0].messageId).toBe('msg_old');
    expect(next[1].messageId).toBe('msg_new');
  });
});

describe('applyAssistantStreamEvent — no message id (fallback)', () => {
  it('falls back to exact-content dedupe when message lacks an id', () => {
    const event = { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
    const after1 = applyAssistantStreamEvent([], event, tStart);
    const after2 = applyAssistantStreamEvent(after1, event, tMid);

    expect(after1).toHaveLength(1);
    expect(after2).toBe(after1);
  });

  it('appends when content differs and there is no id', () => {
    const e1 = { type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } };
    const e2 = { type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } };
    const after1 = applyAssistantStreamEvent([], e1, tStart);
    const after2 = applyAssistantStreamEvent(after1, e2, tMid);

    expect(after2).toHaveLength(2);
    expect(after2[0].content).toBe('A');
    expect(after2[1].content).toBe('B');
  });
});
