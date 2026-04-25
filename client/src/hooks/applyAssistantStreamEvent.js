// Pure reducer for incorporating an `assistant` stream event into the chat
// message list. Multiple stream events from Claude CLI can share the same
// Anthropic `message.id` while their content grows — we update the existing
// message in place so the UI renders partial content as it streams in.

export function extractAssistantContent(message) {
  if (message == null) return '';
  if (typeof message === 'string') return message;
  if (Array.isArray(message.content)) {
    return message.content
      .filter(block => block && block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }
  return JSON.stringify(message);
}

export function applyAssistantStreamEvent(prev, event, timestamp) {
  const message = event && event.message;
  if (!message) return prev;

  const content = extractAssistantContent(message);
  if (!content) return prev;

  const messageId = (typeof message === 'object' && message.id) ? message.id : null;

  if (messageId) {
    // 1. Same Claude message id already in the list → update in place (streaming).
    for (let i = prev.length - 1; i >= 0; i--) {
      if (prev[i].role === 'assistant' && prev[i].messageId === messageId) {
        const next = [...prev];
        next[i] = { ...next[i], content, timestamp };
        return next;
      }
    }
    // 2. A DB-loaded message (no messageId yet) matches this turn — claim it.
    //    Only look at the tail to avoid touching old turns with similar text.
    const lookback = Math.max(0, prev.length - 10);
    for (let i = prev.length - 1; i >= lookback; i--) {
      const m = prev[i];
      if (m.role !== 'assistant' || m.messageId) continue;
      if (m.content === content || content.startsWith(m.content)) {
        const next = [...prev];
        next[i] = { ...m, content, messageId, timestamp };
        return next;
      }
    }
  } else {
    // No id available — fall back to exact-content dedupe so we don't double-add.
    for (let i = prev.length - 1; i >= 0; i--) {
      if (prev[i].role === 'assistant' && prev[i].content === content) {
        return prev;
      }
    }
  }

  return [...prev, { role: 'assistant', content, messageId, timestamp }];
}
