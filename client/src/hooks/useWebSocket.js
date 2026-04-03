import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../utils/api';
import { pushEvents, clearEvents } from './streamEventStore';
import { useApp } from '../context/AppContext';

let messageIdCounter = 0;

export function useWebSocket(sessionId) {
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('idle');
  const [errorMessage, setErrorMessage] = useState(null);
  const [pendingPermission, setPendingPermission] = useState(null);
  const [streamEvents, setStreamEvents] = useState([]);
  const [resuming, setResuming] = useState(false);
  const [sendError, setSendError] = useState(null);
  // Ref to track resuming state inside the WS closure (avoids stale closure)
  const resumingRef = useRef(false);
  // Map of messageId -> { timeout, resolve } for pending ack tracking
  const pendingMessagesRef = useRef(new Map());
  // Track optimistic user messages that haven't been confirmed by DB yet
  const optimisticMessagesRef = useRef([]);

  // Get shared WebSocket from AppContext
  const { ws: appWsRef, connected } = useApp();

  // Reset all session state when switching sessions so stale data doesn't bleed across
  useEffect(() => {
    setStreamEvents([]);
    setMessages([]);
    setStatus('idle');
    setErrorMessage(null);
    setPendingPermission(null);
    setSendError(null);
    clearEvents();
  }, [sessionId]);

  // Main effect: subscribe to session events on the shared WS
  useEffect(() => {
    if (!sessionId) return;

    const ws = appWsRef?.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // WS not ready yet — effect will re-run when `connected` changes
      return;
    }

    // Subscribe to this session's events
    ws.send(JSON.stringify({ type: 'subscribe_session', sessionId }));

    // Handle messages for this session
    const handler = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Filter: only handle events for our session (or events without sessionId like pong)
        if (data.sessionId && data.sessionId !== sessionId) return;

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
                setMessages(prev => [...prev, {
                  role: 'assistant',
                  content,
                  timestamp: data.timestamp
                }]);
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
            setMessages(prev => {
              // Try to find and replace the optimistic message by id
              const idx = prev.findIndex(m => m.optimisticId && m.content === data.content);
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = {
                  role: 'user',
                  content: data.content,
                  timestamp: data.timestamp,
                  attachments: data.attachments || null
                };
                return updated;
              }
              return [...prev, {
                role: 'user',
                content: data.content,
                timestamp: data.timestamp,
                attachments: data.attachments || null
              }];
            });
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
            // Keep messages visible so user can still read the conversation
            // Only clear stream events (CLI panel) since the process is gone
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

          case 'quality_result':
            setMessages(prev => [...prev, {
              role: 'quality',
              ruleId: data.ruleId,
              ruleName: data.ruleName,
              result: data.result,
              severity: data.severity,
              details: data.details,
              analysis: data.analysis,
              trigger: data.trigger,
              timestamp: data.timestamp
            }]);
            break;

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
    ws.addEventListener('message', handler);

    return () => {
      ws.removeEventListener('message', handler);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'unsubscribe_session', sessionId }));
      }
    };
  }, [sessionId, appWsRef, connected]);

  // Re-subscribe on WebSocket reconnect and reload messages from DB
  useEffect(() => {
    if (!sessionId) return;
    const onReconnect = () => {
      // subscribe_session is handled by the main effect re-running on `connected` change

      // Clear any pending message ack timeouts on reconnect
      if (pendingMessagesRef.current.size > 0) {
        for (const [, pending] of pendingMessagesRef.current) {
          clearTimeout(pending.timeout);
        }
        setSendError('Connection lost. Your message may not have been delivered.');
        pendingMessagesRef.current.clear();
      }

      // Reload messages from DB since we may have missed events while disconnected
      api.get(`/api/sessions/${sessionId}/messages`).then(result => {
        const dbMessages = result.messages.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
          attachments: m.attachments ? JSON.parse(m.attachments) : null,
        }));
        // Re-append any optimistic messages not yet in DB
        const pending = optimisticMessagesRef.current.filter(
          opt => !dbMessages.some(db => db.role === 'user' && db.content === opt.content)
        );
        setMessages([...dbMessages, ...pending]);
      }).catch(e => console.error('[WS] Failed to reload messages on reconnect:', e.message));
    };
    window.addEventListener('ws-reconnected', onReconnect);
    return () => window.removeEventListener('ws-reconnected', onReconnect);
  }, [sessionId, appWsRef]);

  const sendMessage = useCallback((content, attachments = null) => {
    const ws = appWsRef?.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
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
      ws.send(JSON.stringify(msg));
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
      optimisticId: messageId,
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
  }, [sessionId, appWsRef]);

  const approvePermission = useCallback((approved = true) => {
    const ws = appWsRef?.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'approve_permission',
        sessionId,
        approved
      }));
      setPendingPermission(null);
    }
  }, [sessionId, appWsRef]);

  const clearSendError = useCallback(() => setSendError(null), []);

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
    optimisticMessagesRef
  };
}
