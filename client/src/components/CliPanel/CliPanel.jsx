// client/src/components/CliPanel/CliPanel.jsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { subscribe, getEvents, clearEvents } from '../../hooks/streamEventStore';
import { api } from '../../utils/api';
import styles from './CliPanel.module.css';

const MAX_LINES = 5000;

function formatToolUseBlock(block) {
  const name = block.name || 'unknown';
  let args = '';
  if (block.input) {
    const inp = block.input;
    args = inp.command || inp.path || inp.file_path || inp.pattern || inp.description || JSON.stringify(inp).slice(0, 120);
  }
  return { text: `▶ ${name}${args ? `  ${args}` : ''}`, variant: 'tool' };
}

function formatToolResultBlock(block) {
  const raw = block.content || '';
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const trimmed = text.trim().slice(0, 300);
  if (!trimmed) return null;
  return { text: `  ${trimmed}${text.length > 300 ? ' …' : ''}`, variant: 'result' };
}

// Returns an array of lines (one event can produce multiple lines)
function formatStreamEvent(event) {
  if (!event) return [];
  const lines = [];

  switch (event.type) {
    case 'assistant': {
      const msg = event.message;
      if (!msg) break;
      const blocks = Array.isArray(msg.content) ? msg.content : [];

      // Extract text blocks
      let text = '';
      if (typeof msg === 'string') {
        text = msg;
      } else if (blocks.length > 0) {
        text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
      } else if (typeof msg.content === 'string') {
        text = msg.content;
      }
      if (text.trim()) {
        lines.push({ text: `Claude: ${text}`, variant: 'assistant' });
      }

      // Extract tool_use blocks (bash commands, file reads, etc.)
      for (const block of blocks) {
        if (block.type === 'tool_use') {
          lines.push(formatToolUseBlock(block));
        }
      }
      break;
    }
    case 'user': {
      // Tool results come as user messages with tool_result content blocks
      const msg = event.message;
      if (!msg) break;
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          const line = formatToolResultBlock(block);
          if (line) lines.push(line);
        }
      }
      // Also check tool_use_result at event level (alternate format)
      if (event.tool_use_result) {
        const content = event.tool_use_result.content || event.tool_use_result.file?.content || '';
        if (content) {
          const trimmed = String(content).trim().slice(0, 300);
          if (trimmed) {
            lines.push({ text: `  ${trimmed}${String(content).length > 300 ? ' …' : ''}`, variant: 'result' });
          }
        }
      }
      break;
    }
    case 'tool_use': {
      // Standalone tool_use events (older format)
      lines.push(formatToolUseBlock(event));
      break;
    }
    case 'tool_result': {
      // Standalone tool_result events (older format)
      const line = formatToolResultBlock(event);
      if (line) lines.push(line);
      break;
    }
    case 'system':
      if (event.subtype === 'init') lines.push({ text: `[session started]`, variant: 'muted' });
      break;
    case 'result':
      lines.push({ text: `[done]`, variant: 'muted' });
      break;
  }

  return lines;
}

export default function CliPanel({ sessionId }) {
  const [lines, setLines] = useState([]);
  const [atBottom, setAtBottom] = useState(true);
  const outputRef = useRef(null);
  const processedCountRef = useRef(0);

  // Track how many events came from the DB so we skip duplicates from WebSocket replay
  const dbEventCountRef = useRef(0);

  // Reset when session changes — load persisted events from DB, then subscribe to live events
  useEffect(() => {
    setLines([]);
    setAtBottom(true);
    processedCountRef.current = 0;
    dbEventCountRef.current = 0;
    clearEvents();

    if (!sessionId) return;
    let cancelled = false;

    api.get(`/api/sessions/${sessionId}/stream-events`).then(result => {
      if (cancelled || !result.events || result.events.length === 0) return;
      // Format persisted events into lines
      const historicLines = [];
      for (const event of result.events) {
        historicLines.push(...formatStreamEvent(event));
      }
      if (historicLines.length > 0) {
        setLines(historicLines);
      }
      // Don't set dbEventCountRef here — it blocks live events on resumed sessions
      // where stream_events_history replay doesn't arrive
    }).catch(e => console.error('Failed to load CLI history:', e.message));

    return () => { cancelled = true; };
  }, [sessionId]);

  // Subscribe to shared stream event store
  useEffect(() => {
    function processEvents(events) {
      if (!events || events.length <= processedCountRef.current) return;

      // Skip events already loaded from DB to avoid duplicates.
      // When WebSocket replays stream_events_history, those overlap with DB events.
      const startIdx = Math.max(processedCountRef.current, dbEventCountRef.current);
      if (events.length <= startIdx) {
        processedCountRef.current = events.length;
        return;
      }

      const newEvents = events.slice(startIdx);
      processedCountRef.current = events.length;

      const newLines = [];
      for (const event of newEvents) {
        newLines.push(...formatStreamEvent(event));
      }

      if (newLines.length > 0) {
        setLines(prev => {
          const next = [...prev, ...newLines];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      }
    }

    // Process any events already in the store
    processEvents(getEvents());

    // Subscribe to future events
    return subscribe(processEvents);
  }, [sessionId]);

  // Auto-scroll when lines update, if stuck to bottom
  useEffect(() => {
    if (atBottom && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines, atBottom]);

  const handleScroll = useCallback(() => {
    const el = outputRef.current;
    if (!el) return;
    const isAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    setAtBottom(isAtBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
    setAtBottom(true);
  }, []);

  const clearLines = useCallback(() => {
    setLines([]);
    setAtBottom(true);
  }, []);

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <span className={styles.toolbarLabel}>CLI Output</span>
        <div className={styles.toolbarActions}>
          <button
            className={`btn-ghost btn-sm ${styles.clearBtn}`}
            onClick={clearLines}
            title="Clear output"
          >
            Clear
          </button>
        </div>
      </div>
      <div className={styles.outputWrap}>
        <div
          className={styles.output}
          ref={outputRef}
          onScroll={handleScroll}
        >
          {lines.length === 0 ? (
            <span className={styles.empty}>No output yet</span>
          ) : (
            lines.map((line, i) => (
              <span
                key={i}
                className={`${styles.line} ${styles[`line_${line.variant}`] || ''}`}
              >
                {line.text}
              </span>
            ))
          )}
        </div>
        {!atBottom && (
          <button
            className={styles.scrollToBottom}
            onClick={scrollToBottom}
            title="Scroll to bottom"
          >
            ↓
          </button>
        )}
      </div>
    </div>
  );
}
