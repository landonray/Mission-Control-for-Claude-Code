import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../utils/api.js';

const POLL_MS = 30000;

export function usePendingDecisionsCount() {
  const [count, setCount] = useState(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/api/decisions/pending/count');
      if (mountedRef.current) setCount(data?.count ?? 0);
    } catch {
      // best effort — leave previous count
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);

    // Live update: refresh count whenever the dashboard would refresh.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'decisions_changed' || data.type === 'pipeline_status_changed') {
          refresh();
        }
      } catch { /* ignore non-JSON */ }
    };

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      try { ws.close(); } catch { /* noop */ }
    };
  }, [refresh]);

  return { count, refresh };
}
