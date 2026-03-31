// client/src/components/CliPanel/CliPanel.jsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { subscribe, getEvents, clearEvents } from '../../hooks/streamEventStore';
import styles from './CliPanel.module.css';

const MAX_LINES = 5000;

function formatStreamEvent(event) {
  if (!event) return null;
  switch (event.type) {
    case 'assistant': {
      const msg = event.message;
      if (!msg) return null;
      let text = '';
      if (typeof msg === 'string') {
        text = msg;
      } else if (Array.isArray(msg.content)) {
        text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
      } else if (typeof msg.content === 'string') {
        text = msg.content;
      }
      if (!text.trim()) return null;
      return { text: `Claude: ${text}`, variant: 'assistant' };
    }
    case 'tool_use': {
      const name = event.tool || event.name || 'unknown';
      let args = '';
      if (event.input) {
        const inp = event.input;
        args = inp.command || inp.path || inp.file_path || inp.pattern || inp.description || JSON.stringify(inp).slice(0, 120);
      }
      return { text: `▶ ${name}${args ? `  ${args}` : ''}`, variant: 'tool' };
    }
    case 'tool_result': {
      if (!event.content) return null;
      const text = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
      const trimmed = text.trim().slice(0, 300);
      if (!trimmed) return null;
      return { text: `  ${trimmed}${text.length > 300 ? ' …' : ''}`, variant: 'result' };
    }
    case 'system':
      if (event.subtype === 'init') return { text: `[session started]`, variant: 'muted' };
      return null;
    case 'result':
      return { text: `[done]`, variant: 'muted' };
    default:
      return null;
  }
}

export default function CliPanel({ sessionId }) {
  const [lines, setLines] = useState([]);
  const [atBottom, setAtBottom] = useState(true);
  const outputRef = useRef(null);
  const processedCountRef = useRef(0);

  // Reset when session changes — clear global event store so stale data isn't reprocessed
  useEffect(() => {
    setLines([]);
    setAtBottom(true);
    processedCountRef.current = 0;
    clearEvents();
  }, [sessionId]);

  // Subscribe to shared stream event store
  useEffect(() => {
    function processEvents(events) {
      if (!events || events.length <= processedCountRef.current) return;

      const newEvents = events.slice(processedCountRef.current);
      processedCountRef.current = events.length;

      const newLines = [];
      for (const event of newEvents) {
        const line = formatStreamEvent(event);
        if (line) newLines.push(line);
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
