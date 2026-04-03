import { useEffect } from 'react';
import { useApp } from '../context/AppContext';

export function Toast() {
  const { toast, setToast } = useApp();

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast, setToast]);

  if (!toast) return null;

  return (
    <div style={{
      position: 'fixed', bottom: 20, right: 20,
      background: toast.type === 'error' ? '#dc2626' : '#16a34a',
      color: 'white', padding: '12px 20px', borderRadius: 8,
      zIndex: 9999, maxWidth: 400, fontSize: 14
    }}>
      {toast.message}
    </div>
  );
}
