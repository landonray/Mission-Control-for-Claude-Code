import React, { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import ChatInterface from './ChatInterface';
import { ArrowLeft } from 'lucide-react';

export default function SessionView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { dispatch } = useApp();

  useEffect(() => {
    if (id && id !== 'active') {
      dispatch({ type: 'SET_ACTIVE_SESSION', payload: id });
    }
  }, [id, dispatch]);

  if (!id || id === 'active') {
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <p>Select a session from the dashboard</p>
        <button className="btn btn-secondary" onClick={() => navigate('/')} style={{ marginTop: 12 }}>
          <ArrowLeft size={14} /> Back to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>
          <ArrowLeft size={14} /> Back
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <ChatInterface sessionId={id} />
      </div>
    </div>
  );
}
