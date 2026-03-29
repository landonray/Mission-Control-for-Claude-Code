import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { timeAgo, getContextHealthLevel } from '../../utils/format';
import NewSessionModal from './NewSessionModal';
import { Plus, Activity, Circle, Clock, AlertCircle, Pause, CheckCircle } from 'lucide-react';
import styles from './SessionList.module.css';

const statusIcons = {
  working: Activity,
  idle: CheckCircle,
  waiting: Clock,
  error: AlertCircle,
  paused: Pause,
  ended: Circle,
};

export default function SessionList() {
  const { sessions, loadSessions, dispatch } = useApp();
  const [showNewSession, setShowNewSession] = useState(false);
  const navigate = useNavigate();
  const { id: activeId } = useParams();

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 10000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  const handleSelect = (sessionId) => {
    dispatch({ type: 'SET_ACTIVE_SESSION', payload: sessionId });
    navigate(`/session/${sessionId}`);
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Sessions</h2>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowNewSession(true)}
        >
          <Plus size={14} /> New
        </button>
      </div>

      <div className="panel-body" style={{ padding: 0 }}>
        {sessions.map(session => {
          const StatusIcon = statusIcons[session.status] || Circle;
          const contextLevel = getContextHealthLevel(session.context_window_usage || 0);
          const isActive = session.id === activeId;

          return (
            <div
              key={session.id}
              className={`${styles.item} ${isActive ? styles.active : ''}`}
              onClick={() => handleSelect(session.id)}
            >
              <div className={styles.header}>
                <StatusIcon
                  size={12}
                  className={`status-${session.status}`}
                  style={session.status === 'working' ? { animation: 'pulse 2s infinite' } : {}}
                />
                <span className={styles.name}>{session.name}</span>
              </div>

              <div className={styles.meta}>
                <div className={styles.contextDot}>
                  <span
                    className={styles.dot}
                    style={{
                      backgroundColor: contextLevel === 'light' ? 'var(--success)'
                        : contextLevel === 'moderate' ? 'var(--warning)'
                        : contextLevel === 'heavy' ? '#f97316'
                        : 'var(--error)'
                    }}
                  />
                  <span>{Math.round((session.context_window_usage || 0) * 100)}%</span>
                </div>
                <span className={styles.time}>{timeAgo(session.last_activity_at)}</span>
              </div>

              {session.last_action_summary && (
                <p className={styles.summary}>{session.last_action_summary}</p>
              )}
            </div>
          );
        })}

        {sessions.length === 0 && (
          <div className="empty-state" style={{ padding: '24px 16px' }}>
            <p style={{ fontSize: 13 }}>No sessions yet</p>
          </div>
        )}
      </div>

      {showNewSession && (
        <NewSessionModal onClose={() => setShowNewSession(false)} />
      )}
    </div>
  );
}
