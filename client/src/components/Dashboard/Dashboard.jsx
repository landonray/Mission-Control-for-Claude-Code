import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import SessionCard from './SessionCard';
import NewSessionModal from './NewSessionModal';
import { useCollapsedProjects } from '../../hooks/useCollapsedProjects';
import { Plus, RefreshCw, Filter, Rocket, Terminal, Search, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  const { sessions, loadSessions } = useApp();
  const [showNewSession, setShowNewSession] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [contentMatchIds, setContentMatchIds] = useState(new Set());
  const { collapsedProjects, toggleProject } = useCollapsedProjects();
  const searchTimerRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const searchContent = useCallback((query) => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!query || query.length < 2) {
      setContentMatchIds(new Set());
      return;
    }
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await api.get(`/api/history/search?q=${encodeURIComponent(query)}&limit=100`);
        const ids = new Set(results.map(r => r.session_id));
        setContentMatchIds(ids);
      } catch {
        setContentMatchIds(new Set());
      }
    }, 300);
  }, []);

  const handleSearchChange = (e) => {
    const value = e.target.value;
    setSearchQuery(value);
    searchContent(value.trim());
  };

  const handleSearchClear = () => {
    setSearchQuery('');
    setContentMatchIds(new Set());
  };

  const filteredSessions = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return sessions.filter(session => {
      if (session.archived && !showArchived) return false;
      if (session.status === 'ended' && !session.archived && !showEnded) return false;
      if (query) {
        const name = (session.name || '').toLowerCase();
        const lastAction = (session.last_action_summary || '').toLowerCase();
        if (!name.includes(query) && !lastAction.includes(query) && !contentMatchIds.has(session.id)) return false;
      }
      return true;
    });
  }, [sessions, showEnded, showArchived, searchQuery, contentMatchIds]);

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

      <div className={styles.searchBar}>
        <Search size={16} className={styles.searchIcon} />
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={handleSearchChange}
        />
        {searchQuery && (
          <button className={styles.searchClear} onClick={handleSearchClear}>&times;</button>
        )}
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

      {groupedSessions.map(([projectName, projectSessions]) => {
        const isCollapsed = collapsedProjects.has(projectName);
        const projectId = projectSessions.find(s => s.project_id)?.project_id || null;
        return (
          <section key={projectName} className={styles.section}>
            <h2
              className={styles.sectionHeader}
              onClick={() => toggleProject(projectName)}
            >
              <span className={styles.collapseIcon}>
                {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </span>
              {projectId ? (
                <button
                  type="button"
                  className={styles.projectNameLink}
                  onClick={(e) => { e.stopPropagation(); navigate(`/projects/${projectId}`); }}
                  title="Open project detail"
                >
                  {projectName}
                  <ExternalLink size={11} />
                </button>
              ) : (
                projectName
              )}
              <span className={styles.sessionCount}>{projectSessions.length}</span>
            </h2>
            {!isCollapsed && (
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
            )}
          </section>
        );
      })}

      {filteredSessions.length === 0 && (
        <div className="empty-state">
          {sessions.length === 0 ? (
            <>
              <div className={styles.emptyIcon}>
                <Rocket size={32} />
              </div>
              <h3>No Sessions Yet</h3>
              <p>Launch your first Claude Code session and start building</p>
              <button className={`btn btn-primary ${styles.launchBtn}`} onClick={() => setShowNewSession(true)}>
                <Terminal size={16} /> Launch Session
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
