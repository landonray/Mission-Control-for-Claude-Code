// client/src/components/CliPanel/CliPanel.jsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import styles from './CliPanel.module.css';

const MAX_LINES = 5000;

export default function CliPanel({ sessionId }) {
  const [lines, setLines] = useState([]);
  const [atBottom, setAtBottom] = useState(true);
  const outputRef = useRef(null);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!sessionId) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe_session', sessionId }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'raw_output' || data.type === 'stderr') {
          if (data.sessionId !== sessionId) return;
          setLines(prev => {
            const next = [...prev, { text: data.data, isStderr: data.type === 'stderr' }];
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        }
      } catch (e) {}
    };

    ws.onclose = () => {};

    return () => {
      ws.close();
    };
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
            className="btn-ghost btn-sm"
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
                className={`${styles.line}${line.isStderr ? ` ${styles.lineStderr}` : ''}`}
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
