import React, { useState, useEffect, useRef } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import MessageList from './MessageList';
import PermissionPrompt from './PermissionPrompt';
import SessionControls from './SessionControls';
import ContextIndicator from './ContextIndicator';
import QualityScorecard from '../Quality/QualityScorecard';
import { Send, Loader, RotateCcw } from 'lucide-react';
import styles from './ChatInterface.module.css';

export default function ChatInterface({ sessionId }) {
  const { sessions } = useApp();
  const session = sessions.find(s => s.id === sessionId);
  const {
    messages, setMessages, status, errorMessage, pendingPermission,
    streamEvents, sendMessage, approvePermission, resuming
  } = useWebSocket(sessionId);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const textareaRef = useRef(null);

  // Load existing messages
  useEffect(() => {
    async function loadMessages() {
      try {
        const result = await api.get(`/api/sessions/${sessionId}/messages`);
        setMessages(result.messages.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
        })));
      } catch (e) {}
      setLoading(false);
    }
    loadMessages();
  }, [sessionId]);

  // Only truly disabled on error — ended sessions can be resumed
  const isDisabled = status === 'error';
  const isEnded = status === 'ended';

  const handleSend = () => {
    const text = input.trim();
    if (!text || isDisabled) return;

    sendMessage(text);
    setInput('');

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaChange = (e) => {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  };

  return (
    <div className={styles.chat}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.title}>{session?.name || 'Session'}</h2>
          <span className={`badge badge-${status}`}>{status}</span>
        </div>
        <div className={styles.headerRight}>
          <ContextIndicator usage={session?.context_window_usage || 0} />
          <SessionControls sessionId={sessionId} status={status} session={session} />
        </div>
      </div>

      {/* Quality Scorecard */}
      <div style={{ padding: '0 16px', flexShrink: 0 }}>
        <QualityScorecard sessionId={sessionId} />
      </div>

      {/* Resume Indicator */}
      {resuming && (
        <div className={styles.resumeIndicator}>
          <RotateCcw size={14} className="animate-spin" />
          <span>Restoring session context…</span>
        </div>
      )}

      {/* Messages */}
      <MessageList messages={messages} loading={loading} streamEvents={streamEvents} />

      {/* Permission Prompt */}
      {pendingPermission && (
        <PermissionPrompt
          permission={pendingPermission}
          onApprove={() => approvePermission(true)}
          onDeny={() => approvePermission(false)}
        />
      )}

      {/* Input — always active for ended sessions (triggers resume) */}
      <div className={styles.inputArea}>
        <div className={styles.inputWrapper}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            placeholder={
              status === 'error'
                ? `Session failed to start: ${errorMessage || 'unknown error'}`
                : isEnded
                  ? 'Type a message to resume this session...'
                  : 'Send a message... (Enter to send, Shift+Enter for new line)'
            }
            disabled={isDisabled}
            rows={1}
          />
          <button
            className={`btn btn-primary ${styles.sendBtn}`}
            onClick={handleSend}
            disabled={!input.trim() || isDisabled}
          >
            {status === 'working' || resuming
              ? <Loader size={16} className="animate-spin" />
              : isEnded
                ? <RotateCcw size={16} />
                : <Send size={16} />
            }
          </button>
        </div>
      </div>
    </div>
  );
}
