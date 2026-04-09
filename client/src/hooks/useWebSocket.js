import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../utils/api';
import { pushEvents, clearEvents } from './streamEventStore';

let messageIdCounter = 0;

export function useWebSocket(sessionId) {
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('idle');
  const [errorMessage, setErrorMessage] = useState(null);
  const [pendingPermission, setPendingPermission] = useState(null);
  const [streamEvents, setStreamEvents] = useState([]);
  const [resuming, setResuming] = useState(false);
  const [sendError, setSendError] = useState(null);
  const wsRef = useRef(null);
  // Ref to track resuming state inside the WS closure (avoids stale closure)
  const resumingRef = useRef(false);
  const reconnectTimerRef = useRef(null);
  // Map of messageId -> { timeout, resolve } for pending ack tracking
  const pendingMessagesRef = useRef(new Map());
  // Track optimistic user messages that haven't been confirmed by DB yet
  const optimisticMessagesRef = useRef([]);

  // Reset stream events when session changes so stale CLI output doesn't bleed across sessions
  useEffect(() => {
    setStreamEvents([]);
  }, [sessionId]);

  // Clear send errors when switching sessions so stale errors don't persist
  useEffect(() => {
    setSendError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsHost = window.location.hostname + ':3001';
      const ws = new WebSocket(`${protocol}//${wsHost}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe_session', sessionId }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          switch (data.type) {
            case 'session_status':
              setStatus(data.status);
              if (data.pendingPermission) {
                setPendingPermission(data.pendingPermission);
              }
              if (data.errorMessage) {
                setErrorMessage(data.errorMessage);
              }
              if (data.status !== 'error') {
                setErrorMessage(null);
              }
              break;

            case 'quality_checks_done':
              // No-op — status transition handled by session_status event
              break;

            case 'session_resuming':
              resumingRef.current = true;
              setResuming(true);
              setStatus('working');
              break;

            case 'stream_event':
              // First stream event after resume means context is restored
              if (resumingRef.current) {
                resumingRef.current = false;
                setResuming(false);
              }
              setStatus(data.status);
              setStreamEvents(prev => {
                const next = [...prev, data.event];
                pushEvents(next);
                return next;
              });

              if (data.event?.type === 'assistant' && data.event?.message) {
                let content;
                const msg = data.event.message;
                if (typeof msg === 'string') {
                  content = msg;
                } else if (msg.content && Array.isArray(msg.content)) {
                  content = msg.content
                    .filter(block => block.type === 'text')
                    .map(block => block.text)
                    .join('\n');
                } else {
                  content = JSON.stringify(msg);
                }
                if (content) {
                  setMessages(prev => {
                    // Deduplicate — the message may already exist from loadMessages DB fetch.
                    // Check all messages (not just last 10) to catch duplicates from earlier
                    // in the conversation that may have been loaded from the database.
                    for (let i = prev.length - 1; i >= 0; i--) {
                      if (prev[i].role === 'assistant' && prev[i].content === content) {
                        // Update the existing message's content in place (it may have grown)
                        return prev;
                      }
                    }
                    return [...prev, {
                      role: 'assistant',
                      content,
                      timestamp: data.timestamp
                    }];
                  });
                }
              }

              if (data.event?.type === 'permission_request') {
                setPendingPermission(data.event);
              }

              break;

            case 'stream_events_history':
              // Replay buffered stream events from server (for idle sessions)
              setStreamEvents(data.events);
              pushEvents(data.events);
              break;

            case 'user_message':
              // Clear from optimistic tracking — it's now confirmed in DB
              optimisticMessagesRef.current = optimisticMessagesRef.current.filter(
                m => m.content !== data.content
              );
              // Deduplicate — the message may already exist from optimistic add.
              // Check all recent messages (not just last) since other events can
              // arrive between the optimistic add and the server broadcast.
              setMessages(prev => {
                for (let i = prev.length - 1; i >= 0 && i >= prev.length - 10; i--) {
                  if (prev[i].role === 'user' && prev[i].content === data.content) {
                    // If server says it's queued, update the existing message
                    if (data.queued && !prev[i].queued) {
                      const next = [...prev];
                      next[i] = { ...next[i], queued: true };
                      return next;
                    }
                    return prev;
                  }
                }
                return [...prev, {
                  role: 'user',
                  content: data.content,
                  timestamp: data.timestamp,
                  attachments: data.attachments || null,
                  queued: !!data.queued
                }];
              });
              break;

            case 'message_dequeued':
              // Message has been picked up from the queue — remove queued flag
              setMessages(prev => {
                for (let i = prev.length - 1; i >= 0; i--) {
                  if (prev[i].role === 'user' && prev[i].queued && prev[i].content === data.content) {
                    const next = [...prev];
                    next[i] = { ...next[i], queued: false };
                    return next;
                  }
                }
                return prev;
              });
              break;

            case 'message_deleted':
              setMessages(prev => {
                // Remove the message with matching content
                // Search from the end since queued messages are recent
                for (let i = prev.length - 1; i >= 0; i--) {
                  if (prev[i].role === 'user' && prev[i].content === data.content) {
                    const next = [...prev];
                    next.splice(i, 1);
                    return next;
                  }
                }
                return prev;
              });
              // Also remove from optimistic tracking if present
              optimisticMessagesRef.current = optimisticMessagesRef.current.filter(
                m => m.content !== data.content
              );
              break;

            case 'permission_response':
              setPendingPermission(null);
              break;

            case 'session_name_updated':
              // Handled by AppContext — no local state needed
              break;

            case 'session_ended':
              setStatus('ended');
              resumingRef.current = false;
              setResuming(false);
              // Blank chat and CLI panels
              setMessages([]);
              setStreamEvents([]);
              clearEvents();
              break;

            case 'session_paused':
              setStatus('paused');
              break;

            case 'session_resumed':
              setStatus('idle');
              break;

            case 'message_ack': {
              const pending = pendingMessagesRef.current.get(data.messageId);
              if (pending) {
                clearTimeout(pending.timeout);
                pendingMessagesRef.current.delete(data.messageId);
                if (data.status === 'failed') {
                  setSendError(data.error || 'Message failed to send.');
                } else {
                  setSendError(null);
                }
              }
              break;
            }

            case 'quality_running': {
              const runningQuality = {
                role: 'quality',
                ruleId: data.ruleId,
                ruleName: data.ruleName,
                result: 'running',
                severity: data.severity,
                trigger: data.trigger,
                timestamp: data.timestamp
              };
              setMessages(prev => {
                // Don't add if already running or already have a result for this rule
                const exists = prev.some(m =>
                  m.role === 'quality' && m.ruleId === data.ruleId && m.timestamp === data.timestamp
                );
                return exists ? prev : [...prev, runningQuality];
              });
              break;
            }

            case 'quality_result': {
              const newQuality = {
                role: 'quality',
                ruleId: data.ruleId,
                ruleName: data.ruleName,
                result: data.result,
                severity: data.severity,
                details: data.details,
                analysis: data.analysis,
                trigger: data.trigger,
                timestamp: data.timestamp
              };
              setMessages(prev => {
                // Replace the 'running' placeholder for this rule, or deduplicate
                const runningIdx = prev.findIndex(m =>
                  m.role === 'quality' && m.ruleId === data.ruleId && m.result === 'running'
                );
                if (runningIdx !== -1) {
                  const next = [...prev];
                  next[runningIdx] = newQuality;
                  return next;
                }
                // Deduplicate — may already exist from initial DB load
                const isDup = prev.some(m =>
                  m.role === 'quality' && m.ruleId === data.ruleId && m.timestamp === data.timestamp
                );
                return isDup ? prev : [...prev, newQuality];
              });
              break;
            }

            case 'error':
              setStatus('error');
              resumingRef.current = false;
              setResuming(false);
              if (data.error) {
                setErrorMessage(data.error);
              }
              break;
          }
        } catch (e) {
          console.error('[WS] Message parse error:', e);
        }
      };

      ws.onclose = () => {
        // Clear any pending message ack timeouts on disconnect
        if (pendingMessagesRef.current.size > 0) {
          for (const [, pending] of pendingMessagesRef.current) {
            clearTimeout(pending.timeout);
          }
          setSendError('Connection lost. Your message may not have been delivered.');
          pendingMessagesRef.current.clear();
        }
        // Reconnect after server restart — reload messages from DB on reconnect
        if (!cancelled) {
          reconnectTimerRef.current = setTimeout(() => {
            if (!cancelled) {
              console.log('[WS] Reconnecting...');
              connect();
              // Reload messages, quality results, and running checks since we may have missed events
              Promise.all([
                api.get(`/api/sessions/${sessionId}/messages`),
                api.get(`/api/quality/results/session/${sessionId}`).catch(() => ({ results: [] })),
                api.get(`/api/quality/results/running/${sessionId}`).catch(() => ({ running: [] })),
              ]).then(([msgResult, qualityResult, runningResult]) => {
                if (!cancelled) {
                  const dbMessages = msgResult.messages.map(m => ({
                    role: m.role,
                    content: m.content,
                    timestamp: m.timestamp,
                    toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
                    attachments: m.attachments ? JSON.parse(m.attachments) : null,
                  }));
                  const qualityMessages = qualityResult.results.map(r => ({
                    role: 'quality',
                    ruleId: r.rule_id,
                    ruleName: r.rule_name,
                    result: r.result,
                    severity: r.severity,
                    details: r.details,
                    analysis: r.analysis || null,
                    trigger: null,
                    timestamp: r.timestamp,
                  }));
                  const runningMessages = (runningResult.running || []).map(r => ({
                    role: 'quality',
                    ruleId: r.ruleId,
                    ruleName: r.ruleName,
                    result: 'running',
                    severity: r.severity,
                    trigger: r.trigger,
                    timestamp: r.timestamp,
                  }));
                  const allMessages = [...dbMessages, ...qualityMessages, ...runningMessages].sort(
                    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
                  );
                  // Re-append any optimistic messages not yet in DB
                  const pending = optimisticMessagesRef.current.filter(
                    opt => !dbMessages.some(db => db.role === 'user' && db.content === opt.content)
                  );
                  setMessages([...allMessages, ...pending]);
                }
              }).catch(e => console.error('[WS] Failed to reload messages on reconnect:', e.message));
            }
          }, 2000);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [sessionId]);

  const sendMessage = useCallback((content, attachments = null) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setSendError('Not connected. Please wait and try again.');
      return false;
    }
    const messageId = ++messageIdCounter;
    const msg = {
      type: 'send_message',
      sessionId,
      content,
      messageId
    };
    if (attachments && attachments.length > 0) {
      msg.attachments = attachments;
    }
    try {
      wsRef.current.send(JSON.stringify(msg));
    } catch (e) {
      console.error('[WS] send failed:', e);
      setSendError('Failed to send message. Please try again.');
      return false;
    }
    // Optimistically add user message so it appears immediately
    // (don't wait for server broadcast, which can race with loadMessages)
    const optimisticMsg = {
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      attachments: attachments || null
    };
    optimisticMessagesRef.current.push(optimisticMsg);
    setMessages(prev => [...prev, optimisticMsg]);
    // Track this message — if no ack within 10s, show error
    const timeout = setTimeout(() => {
      if (pendingMessagesRef.current.has(messageId)) {
        pendingMessagesRef.current.delete(messageId);
        setSendError('No response from server. Claude may not have received your message.');
      }
    }, 10000);
    pendingMessagesRef.current.set(messageId, { timeout });
    setSendError(null);
    return true;
  }, [sessionId]);

  const approvePermission = useCallback((approved = true) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'approve_permission',
        sessionId,
        approved
      }));
      setPendingPermission(null);
    }
  }, [sessionId]);

  const clearSendError = useCallback(() => setSendError(null), []);

  const cancelQualityCheck = useCallback((ruleId) => {
    return api.post(`/api/quality/cancel/${sessionId}/${ruleId}`).catch(() => {});
  }, [sessionId]);

  const deleteQueuedMessage = useCallback((content) => {
    return api.post(`/api/sessions/${sessionId}/delete-queued-message`, { content }).catch(() => {
      setSendError('Message already sent — could not delete.');
    });
  }, [sessionId]);

  const interruptAndSend = useCallback(() => {
    return api.post(`/api/sessions/${sessionId}/interrupt`).catch(() => {
      setSendError('Could not interrupt session.');
    });
  }, [sessionId]);

  return {
    messages,
    setMessages,
    status,
    errorMessage,
    pendingPermission,
    streamEvents,
    sendMessage,
    approvePermission,
    resuming,
    sendError,
    clearSendError,
    optimisticMessagesRef,
    cancelQualityCheck,
    deleteQueuedMessage,
    interruptAndSend
  };
}
