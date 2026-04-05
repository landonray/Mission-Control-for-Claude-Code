import React, { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import ChatInterface from './ChatInterface';
import { ArrowLeft } from 'lucide-react';
import styles from './SessionView.module.css';

export default function SessionView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { sessions, dispatch } = useApp();
  const session = sessions.find(s => s.id === id);

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
      <div className={styles.backBar}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>
          <ArrowLeft size={14} /> Back
        </button>
        {session?.name && (
          <span className={styles.mobileTitle}>{session.name}</span>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <ChatInterface sessionId={id} />
      </div>
    </div>
  );
}
