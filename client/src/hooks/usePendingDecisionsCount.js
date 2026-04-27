import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../utils/api.js';

const POLL_MS = 30000;

export function usePendingDecisionsCount() {
  const [count, setCount] = useState(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/api/planning/escalations/count');
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
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return { count, refresh };
}
