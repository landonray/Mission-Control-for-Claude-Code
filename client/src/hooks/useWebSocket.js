import { useState, useEffect, useCallback, useRef } from 'react';

export function useWebSocket(sessionId) {
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('idle');
  const [pendingPermission, setPendingPermission] = useState(null);
  const [streamEvents, setStreamEvents] = useState([]);
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

        switch (data.type) {
          case 'session_status':
            setStatus(data.status);
            if (data.pendingPermission) {
              setPendingPermission(data.pendingPermission);
            }
            break;

          case 'stream_event':
            setStatus(data.status);
            setStreamEvents(prev => [...prev, data.event]);

            if (data.event?.type === 'assistant' && data.event?.message) {
              const content = typeof data.event.message === 'string'
                ? data.event.message
                : JSON.stringify(data.event.message);
              setMessages(prev => [...prev, {
                role: 'assistant',
                content,
                timestamp: data.timestamp
              }]);
            }

            if (data.event?.type === 'permission_request') {
              setPendingPermission(data.event);
            }

            if (data.event?.type === 'result' && data.event?.result) {
              const content = typeof data.event.result === 'string'
                ? data.event.result
                : JSON.stringify(data.event.result);
              setMessages(prev => [...prev, {
                role: 'assistant',
                content,
                timestamp: data.timestamp,
                isResult: true
              }]);
            }
            break;

          case 'user_message':
            setMessages(prev => [...prev, {
              role: 'user',
              content: data.content,
              timestamp: data.timestamp
            }]);
            break;

          case 'permission_response':
            setPendingPermission(null);
            break;

          case 'session_ended':
            setStatus('ended');
            break;

          case 'session_paused':
            setStatus('paused');
            break;

          case 'session_resumed':
            setStatus('idle');
            break;

          case 'error':
            setStatus('error');
            break;
        }
      } catch (e) {}
    };

    ws.onclose = () => {};

    return () => {
      ws.close();
    };
  }, [sessionId]);

  const sendMessage = useCallback((content) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'send_message',
        sessionId,
        content
      }));
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
    pendingPermission,
    streamEvents,
    sendMessage,
    approvePermission
  };
}
