import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import SessionCard from './SessionCard';
import NewSessionModal from './NewSessionModal';
import { Plus, RefreshCw, Filter } from 'lucide-react';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  const { sessions, loadSessions } = useApp();
  const [showNewSession, setShowNewSession] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const filteredSessions = useMemo(() => {
    return sessions.filter(session => {
      if (session.archived && !showArchived) return false;
      if (session.status === 'ended' && !session.archived && !showEnded) return false;
      return true;
    });
  }, [sessions, showEnded, showArchived]);

  const groupedSessions = useMemo(() => {
    const groups = new Map();
    for (const session of filteredSessions) {
      const project = session.project_name || 'Ungrouped';
      if (!groups.has(project)) groups.set(project, []);
      groups.get(project).push(session);
    }
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === 'Ungrouped') return 1;
      if (b[0] === 'Ungrouped') return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [filteredSessions]);

  const endedCount = sessions.filter(s => s.status === 'ended' && !s.archived).length;
  const archivedCount = sessions.filter(s => s.archived).length;

  const handleArchive = async (sessionId, archived) => {
    await api.post(`/api/sessions/${sessionId}/archive`, { archived });
    loadSessions();
  };

  return (
    <div className={styles.dashboard}>
      <div className={styles.header}>
        <h1>Mission Control</h1>
        <div className={styles.actions}>
          <button
            className={`btn btn-ghost btn-icon ${showFilters ? styles.filterActive : ''}`}
            onClick={() => setShowFilters(f => !f)}
            title="Filter sessions"
          >
            <Filter size={18} />
          </button>
          <button className="btn btn-ghost btn-icon" onClick={loadSessions} title="Refresh">
            <RefreshCw size={18} />
          </button>
          <button className="btn btn-primary" onClick={() => setShowNewSession(true)}>
            <Plus size={16} /> New Session
          </button>
        </div>
      </div>

      {showFilters && (
        <div className={styles.filterBar}>
          <label className={styles.filterToggle}>
            <input
              type="checkbox"
              checked={showEnded}
              onChange={e => setShowEnded(e.target.checked)}
            />
            <span className={styles.filterLabel}>
              Ended
              {endedCount > 0 && <span className={styles.filterCount}>{endedCount}</span>}
            </span>
          </label>
          <label className={styles.filterToggle}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
            />
            <span className={styles.filterLabel}>
              Archived
              {archivedCount > 0 && <span className={styles.filterCount}>{archivedCount}</span>}
            </span>
          </label>
        </div>
      )}

      {groupedSessions.map(([projectName, projectSessions]) => (
        <section key={projectName} className={styles.section}>
          <h2>{projectName}</h2>
          <div className={styles.grid}>
            {projectSessions.map(session => (
              <SessionCard
                key={session.id}
                session={session}
                onClick={() => navigate(`/session/${session.id}`)}
                onArchive={handleArchive}
              />
            ))}
          </div>
        </section>
      ))}

      {filteredSessions.length === 0 && (
        <div className="empty-state">
          {sessions.length === 0 ? (
            <>
              <h3>No Sessions Yet</h3>
              <p>Create your first Claude Code session to get started</p>
              <button className="btn btn-primary" onClick={() => setShowNewSession(true)} style={{ marginTop: 16 }}>
                <Plus size={16} /> New Session
              </button>
            </>
          ) : (
            <p style={{ fontSize: 13 }}>No sessions match filters</p>
          )}
        </div>
      )}

      {showNewSession && (
        <NewSessionModal onClose={() => setShowNewSession(false)} />
      )}
    </div>
  );
}
