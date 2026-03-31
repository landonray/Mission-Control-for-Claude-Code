import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../utils/api';

export function useWebSocket(sessionId) {
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('idle');
  const [errorMessage, setErrorMessage] = useState(null);
  const [pendingPermission, setPendingPermission] = useState(null);
  const [streamEvents, setStreamEvents] = useState([]);
  const [resuming, setResuming] = useState(false);
  const wsRef = useRef(null);
  // Ref to track resuming state inside the WS closure (avoids stale closure)
  const resumingRef = useRef(false);
  const reconnectTimerRef = useRef(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
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
              setStreamEvents(prev => [...prev, data.event]);

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

            case 'user_message':
              setMessages(prev => [...prev, {
                role: 'user',
                content: data.content,
                timestamp: data.timestamp,
                attachments: data.attachments || null
              }]);
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
              break;

            case 'session_paused':
              setStatus('paused');
              break;

            case 'session_resumed':
              setStatus('idle');
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
        } catch (e) {}
      };

      ws.onclose = () => {
        // Reconnect after server restart — reload messages from DB on reconnect
        if (!cancelled) {
          reconnectTimerRef.current = setTimeout(() => {
            if (!cancelled) {
              console.log('[WS] Reconnecting...');
              connect();
              // Reload messages from DB since we may have missed events while disconnected
              api.get(`/api/sessions/${sessionId}/messages`).then(result => {
                if (!cancelled) {
                  setMessages(result.messages.map(m => ({
                    role: m.role,
                    content: m.content,
                    timestamp: m.timestamp,
                    toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
                    attachments: m.attachments ? JSON.parse(m.attachments) : null,
                  })));
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
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg = {
        type: 'send_message',
        sessionId,
        content
      };
      if (attachments && attachments.length > 0) {
        msg.attachments = attachments;
      }
      wsRef.current.send(JSON.stringify(msg));
    }
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

  return {
    messages,
    setMessages,
    status,
    errorMessage,
    pendingPermission,
    streamEvents,
    sendMessage,
    approvePermission,
    resuming
  };
}
