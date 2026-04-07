import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import { timeAgo, getContextHealthLevel, getContextHealthLabel } from '../../utils/format';
import NewSessionModal from './NewSessionModal';
import { Plus, Archive, ArchiveRestore, Filter, GitBranch, Settings, GitCommitHorizontal, GitMerge, Cloud, FileEdit, Search, ChevronDown, ChevronRight } from 'lucide-react';
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
  const [showEnded, setShowEnded] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedProjects, setCollapsedProjects] = useState(new Set());
  const navigate = useNavigate();
  const { id: activeId } = useParams();

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 30000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  const handleSelect = (sessionId) => {
    dispatch({ type: 'SET_ACTIVE_SESSION', payload: sessionId });
    navigate(`/session/${sessionId}`);
  };

  const handleArchive = async (e, sessionId, archived) => {
    e.stopPropagation();
    await api.post(`/api/sessions/${sessionId}/archive`, { archived });
    loadSessions();
  };

  const filteredSessions = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return sessions.filter(session => {
      if (session.archived && !showArchived) return false;
      if (session.status === 'ended' && !session.archived && !showEnded) return false;
      if (query) {
        const name = (session.name || '').toLowerCase();
        const lastAction = (session.last_action_summary || '').toLowerCase();
        if (!name.includes(query) && !lastAction.includes(query)) return false;
      }
      return true;
    });
  }, [sessions, showEnded, showArchived, searchQuery]);

  const toggleProject = (projectName) => {
    setCollapsedProjects(prev => {
      const next = new Set(prev);
      if (next.has(projectName)) next.delete(projectName);
      else next.add(projectName);
      return next;
    });
  };

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

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Sessions</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => navigate('/settings')}
            title="Settings"
          >
            <Settings size={14} />
          </button>
          <button
            className={`btn btn-ghost btn-sm ${showFilters ? styles.filterActive : ''}`}
            onClick={() => setShowFilters(f => !f)}
            title="Filter sessions"
          >
            <Filter size={14} />
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowNewSession(true)}
          >
            <Plus size={14} /> New
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

      <div className={styles.searchBar}>
        <Search size={14} className={styles.searchIcon} />
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button className={styles.searchClear} onClick={() => setSearchQuery('')}>&times;</button>
        )}
      </div>

      <div className="panel-body" style={{ padding: 0 }}>
        {groupedSessions.map(([projectName, projectSessions]) => {
          const isCollapsed = collapsedProjects.has(projectName);
          return (
          <div key={projectName} className={styles.projectGroup}>
            <div className={styles.projectHeader} onClick={() => toggleProject(projectName)}>
              <span className={styles.collapseIcon}>
                {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
              </span>
              {projectName}
              <span className={styles.sessionCount}>{projectSessions.length}</span>
            </div>
            {!isCollapsed && (
            <div className={styles.projectSessions}>
            {projectSessions.map(session => {
              const contextLevel = getContextHealthLevel(session.context_window_usage || 0);
              const contextPercent = Math.round((session.context_window_usage || 0) * 100);
              const isActive = session.id === activeId;

              const cardClass = [
                styles.card,
                isActive ? styles.active : '',
                (session.status === 'working' || session.status === 'reviewing') ? styles.cardWorking : '',
                session.status === 'waiting' ? styles.cardWaiting : '',
                session.archived ? styles.cardArchived : '',
              ].filter(Boolean).join(' ');

              return (
                <div
                  key={session.id}
                  className={cardClass}
                  onClick={() => handleSelect(session.id)}
                >
                  <div className={styles.cardHeader}>
                    <span className={styles.statusDot} data-status={session.status} />
                    <span className={styles.cardName}>{session.name}</span>
                    <span className={`badge badge-${session.archived ? 'ended' : session.status === 'reviewing' ? 'working' : session.status}`}>
                      {session.archived ? 'archived' : session.status}
                    </span>
                    {(session.status === 'ended' || session.archived) && (
                      <button
                        className={styles.archiveBtn}
                        onClick={(e) => handleArchive(e, session.id, !session.archived)}
                        title={session.archived ? 'Unarchive session' : 'Archive session'}
                      >
                        {session.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                      </button>
                    )}
                  </div>

                  {(session.worktree_name || session.branch) && (
                    <div className={styles.branchTag}>
                      <GitBranch size={10} />
                      {session.worktree_name || session.branch}
                    </div>
                  )}

                  {session.pipeline && (
                    <div className={styles.pipelineWrapper}>
                      {session.pipeline.uncommittedCount > 0 && (
                        <div className={styles.uncommittedPill} title={`${session.pipeline.uncommittedCount} uncommitted file${session.pipeline.uncommittedCount === 1 ? '' : 's'}`}>
                          <FileEdit size={9} />
                          <span>{session.pipeline.uncommittedCount} uncommitted</span>
                        </div>
                      )}
                      <div className={styles.pipeline}>
                        <div className={styles.pipelineStage} data-status={session.pipeline.committed} title={`Committed: ${session.pipeline.committed}`}>
                          <GitCommitHorizontal size={10} />
                          <span>Branch</span>
                        </div>
                        <div className={styles.pipelineConnector} data-status={session.pipeline.merged} />
                        <div className={styles.pipelineStage} data-status={session.pipeline.merged} title={`Merged: ${session.pipeline.merged}`}>
                          <GitMerge size={10} />
                          <span>Main</span>
                        </div>
                        <div className={styles.pipelineConnector} data-status={session.pipeline.pushed} />
                        <div className={styles.pipelineStage} data-status={session.pipeline.pushed} title={`Pushed: ${session.pipeline.pushed}`}>
                          <Cloud size={10} />
                          <span>Remote</span>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className={styles.statsSection}>
                    <div className={styles.statRow}>
                      <span className={styles.statLabel}>Last active</span>
                      <span className={styles.statValue}>{timeAgo(session.last_activity_at)}</span>
                    </div>

                    <div className={styles.statRow}>
                      <span className={styles.statLabel}>Diff</span>
                      <span className={styles.statValue}>
                        <span style={{ color: 'var(--success)', fontWeight: 600 }}>+{session.lines_added || 0}</span>
                        {' '}
                        <span style={{ color: 'var(--error)', fontWeight: 600 }}>-{session.lines_removed || 0}</span>
                      </span>
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
                </div>
              );
            })}
            </div>
            )}
          </div>
          );
        })}

        {filteredSessions.length === 0 && (
          <div className="empty-state" style={{ padding: '24px 16px' }}>
            <p style={{ fontSize: 13 }}>
              {sessions.length === 0 ? 'No sessions yet' : 'No sessions match filters'}
            </p>
          </div>
        )}
      </div>

      {showNewSession && (
        <NewSessionModal onClose={() => setShowNewSession(false)} />
      )}
    </div>
  );
}
