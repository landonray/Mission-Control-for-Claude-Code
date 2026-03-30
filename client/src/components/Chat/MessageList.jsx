import React, { useEffect, useRef } from 'react';
import { User, Bot, Wrench, Loader, FileIcon, Download } from 'lucide-react';
import { formatDate } from '../../utils/format';
import styles from './MessageList.module.css';

function MessageAttachments({ attachments }) {
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className={styles.attachments}>
      {attachments.map((file, i) => (
        <a
          key={file.id || i}
          href={file.url}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.attachmentItem}
        >
          {file.isImage ? (
            <img src={file.url} alt={file.originalName} className={styles.attachmentImage} />
          ) : (
            <div className={styles.attachmentFile}>
              <FileIcon size={16} />
              <span className={styles.attachmentFileName}>{file.originalName}</span>
              <Download size={12} className={styles.attachmentDownload} />
            </div>
          )}
        </a>
      ))}
    </div>
  );
}

export default function MessageList({ messages, loading, streamEvents }) {
  const bottomRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !bottomRef.current) return;

    // Only auto-scroll if user is already near the bottom (within 150px)
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
    if (isNearBottom) {
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
            {msg.attachments && msg.attachments.length > 0 && (
              <MessageAttachments attachments={msg.attachments} />
            )}
            <div className={styles.text}>
              {typeof msg.content === 'string' ? msg.content.trim() : msg.content}
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
