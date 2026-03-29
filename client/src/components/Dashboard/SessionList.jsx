import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { timeAgo, getContextHealthLevel, getContextHealthLabel } from '../../utils/format';
import NewSessionModal from './NewSessionModal';
import { Plus } from 'lucide-react';
import styles from './SessionList.module.css';

function renderLastAction(summary) {
  const colonIndex = summary.indexOf(':');
  if (colonIndex > 0 && colonIndex < 20) {
    const tool = summary.slice(0, colonIndex);
    const rest = summary.slice(colonIndex + 1).trim();
    return (
      <>
        <span className={styles.toolPrefix}>{tool}:</span> {rest}
      </>
    );
  }
  return summary;
}

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

  const groupedSessions = useMemo(() => {
    const groups = new Map();
    for (const session of sessions) {
      const project = session.project_name || 'Ungrouped';
      if (!groups.has(project)) groups.set(project, []);
      groups.get(project).push(session);
    }
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === 'Ungrouped') return 1;
      if (b[0] === 'Ungrouped') return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [sessions]);

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
        {groupedSessions.map(([projectName, projectSessions]) => (
          <div key={projectName} className={styles.projectGroup}>
            <div className={styles.projectHeader}>{projectName}</div>
            {projectSessions.map(session => {
              const contextLevel = getContextHealthLevel(session.context_window_usage || 0);
              const contextPercent = Math.round((session.context_window_usage || 0) * 100);
              const isActive = session.id === activeId;

              return (
                <div
                  key={session.id}
                  className={`${styles.card} ${isActive ? styles.active : ''}`}
                  onClick={() => handleSelect(session.id)}
                >
                  <div className={styles.cardHeader}>
                    <span className={styles.statusDot} data-status={session.status} />
                    <span className={styles.cardName}>{session.name}</span>
                    <span className={`badge badge-${session.status}`}>
                      {session.status}
                    </span>
                  </div>

                  <div className={styles.statsSection}>
                    <div className={styles.statRow}>
                      <span className={styles.statLabel}>Last active</span>
                      <span className={styles.statValue}>{timeAgo(session.last_activity_at)}</span>
                    </div>

                    <div className={styles.statRow}>
                      <span className={styles.statLabel}>Messages</span>
                      <span className={styles.statValue}>
                        {session.user_message_count || 0} user / {session.assistant_message_count || 0} assistant
                      </span>
                    </div>

                    <div className={styles.statRow}>
                      <span className={styles.statLabel}>Tool calls</span>
                      <span className={styles.statValue}>{session.tool_call_count || 0}</span>
                    </div>

                    <div className={styles.statRow}>
                      <span className={styles.statLabel}>Context</span>
                      <div className={styles.contextStat}>
                        <div className={styles.contextBar}>
                          <div
                            className={styles.contextFill}
                            style={{
                              width: `${contextPercent}%`,
                              backgroundColor: contextLevel === 'light' ? 'var(--success)'
                                : contextLevel === 'moderate' ? 'var(--warning)'
                                : contextLevel === 'heavy' ? '#f97316'
                                : 'var(--error)'
                            }}
                          />
                        </div>
                        <span className={styles.contextValue}>
                          {contextPercent}% ({getContextHealthLabel(session.context_window_usage || 0).toLowerCase()})
                        </span>
                      </div>
                    </div>

                    {session.last_action_summary && (
                      <div className={styles.statRow}>
                        <span className={styles.statLabel}>Last action</span>
                        <span className={styles.statValue}>
                          {renderLastAction(session.last_action_summary)}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className={styles.cardFooter}>
                    <span className={styles.sessionId}>{session.id.slice(0, 8)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ))}

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
