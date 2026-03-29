import React, { useEffect, useRef } from 'react';
import { User, Bot, Wrench, Loader } from 'lucide-react';
import { formatDate } from '../../utils/format';
import styles from './MessageList.module.css';

export default function MessageList({ messages, loading, streamEvents }) {
  const bottomRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamEvents]);

  // Extract recent tool calls from stream events for indicators
  const recentTools = streamEvents
    .filter(e => e.type === 'tool_use')
    .slice(-5)
    .map(e => e.tool || e.name || 'tool');

  if (loading) {
    return (
      <div className={styles.container} style={{ justifyContent: 'center', alignItems: 'center' }}>
        <Loader size={24} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
      </div>
    );
  }

  return (
    <div className={styles.container} ref={containerRef}>
      {messages.length === 0 && (
        <div className="empty-state">
          <Bot size={32} />
          <p>Send a message to start the conversation</p>
        </div>
      )}

      {messages.map((msg, i) => (
        <div
          key={i}
          className={`${styles.message} ${msg.role === 'user' ? styles.userMessage : styles.assistantMessage}`}
        >
          <div className={styles.avatar}>
            {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
          </div>
          <div className={styles.content}>
            <div className={styles.meta}>
              <span className={styles.role}>{msg.role === 'user' ? 'You' : 'Claude'}</span>
              {msg.timestamp && (
                <span className={styles.time}>{formatDate(msg.timestamp)}</span>
              )}
            </div>
            <div className={styles.text}>
              {msg.content}
            </div>
            {msg.isResult && (
              <div className={styles.resultBadge}>Final Result</div>
            )}
          </div>
        </div>
      ))}

      {/* Tool call indicators */}
      {recentTools.length > 0 && (
        <div className={styles.toolIndicator}>
          <Wrench size={12} />
          <span>Using tools: {recentTools.join(', ')}</span>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
