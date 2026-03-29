import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import SessionCard from './SessionCard';
import NewSessionModal from './NewSessionModal';
import { Plus, RefreshCw } from 'lucide-react';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  const { sessions, loadSessions } = useApp();
  const [showNewSession, setShowNewSession] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const activeSessions = sessions.filter(s => s.status !== 'ended');
  const recentSessions = sessions.filter(s => s.status === 'ended').slice(0, 10);

  return (
    <div className={styles.dashboard}>
      <div className={styles.header}>
        <h1>Mission Control</h1>
        <div className={styles.actions}>
          <button className="btn btn-ghost btn-icon" onClick={loadSessions} title="Refresh">
            <RefreshCw size={18} />
          </button>
          <button className="btn btn-primary" onClick={() => setShowNewSession(true)}>
            <Plus size={16} /> New Session
          </button>
        </div>
      </div>

      {activeSessions.length > 0 && (
        <section className={styles.section}>
          <h2>Active Sessions</h2>
          <div className={styles.grid}>
            {activeSessions.map(session => (
              <SessionCard
                key={session.id}
                session={session}
                onClick={() => navigate(`/session/${session.id}`)}
              />
            ))}
          </div>
        </section>
      )}

      {recentSessions.length > 0 && (
        <section className={styles.section}>
          <h2>Recent Sessions</h2>
          <div className={styles.grid}>
            {recentSessions.map(session => (
              <SessionCard
                key={session.id}
                session={session}
                onClick={() => navigate(`/session/${session.id}`)}
              />
            ))}
          </div>
        </section>
      )}

      {sessions.length === 0 && (
        <div className="empty-state">
          <h3>No Sessions Yet</h3>
          <p>Create your first Claude Code session to get started</p>
          <button className="btn btn-primary" onClick={() => setShowNewSession(true)} style={{ marginTop: 16 }}>
            <Plus size={16} /> New Session
          </button>
        </div>
      )}

      {showNewSession && (
        <NewSessionModal onClose={() => setShowNewSession(false)} />
      )}
    </div>
  );
}
