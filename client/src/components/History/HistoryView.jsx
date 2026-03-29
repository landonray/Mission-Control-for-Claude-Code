import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../utils/api';
import { formatDate, timeAgo } from '../../utils/format';
import { Search, Calendar, MessageSquare, Clock, ArrowLeft, FileText } from 'lucide-react';
import styles from './HistoryView.module.css';

export default function HistoryView() {
  const [sessions, setSessions] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [sessionLog, setSessionLog] = useState(null);
  const [digests, setDigests] = useState([]);
  const [view, setView] = useState('sessions'); // 'sessions' | 'search' | 'log' | 'digests'
  const navigate = useNavigate();

  useEffect(() => {
    loadHistory();
    loadDigests();
  }, []);

  const loadHistory = async () => {
    try {
      const result = await api.get('/api/history/sessions?limit=100');
      setSessions(result.sessions);
    } catch (e) {}
  };

  const loadDigests = async () => {
    try {
      const result = await api.get('/api/history/digests');
      setDigests(result);
    } catch (e) {}
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    try {
      const results = await api.get(`/api/history/search?q=${encodeURIComponent(searchQuery)}`);
      setSearchResults(results);
      setView('search');
    } catch (e) {}
  };

  const viewSessionLog = async (sessionId) => {
    try {
      const result = await api.get(`/api/history/sessions/${sessionId}/log`);
      setSessionLog(result);
      setSelectedSession(sessionId);
      setView('log');
    } catch (e) {}
  };

  const generateDigest = async () => {
    try {
      await api.post('/api/history/digests/generate', { date: new Date().toISOString().split('T')[0] });
      await loadDigests();
    } catch (e) {}
  };

  return (
    <div className={styles.history}>
      <div className={styles.header}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>
          <ArrowLeft size={14} /> Back
        </button>
        <h1>Session History</h1>
      </div>

      {/* Search bar */}
      <div className={styles.searchBar}>
        <Search size={16} />
        <input
          className={styles.searchInput}
          placeholder="Search messages across all sessions..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
        />
        <button className="btn btn-primary btn-sm" onClick={handleSearch}>Search</button>
      </div>

      {/* View tabs */}
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${view === 'sessions' ? styles.activeTab : ''}`}
          onClick={() => setView('sessions')}
        >
          <MessageSquare size={14} /> Sessions
        </button>
        <button
          className={`${styles.tab} ${view === 'digests' ? styles.activeTab : ''}`}
          onClick={() => setView('digests')}
        >
          <Calendar size={14} /> Daily Digests
        </button>
        {view === 'search' && (
          <span className={styles.tab + ' ' + styles.activeTab}>
            <Search size={14} /> Search Results
          </span>
        )}
        {view === 'log' && (
          <span className={styles.tab + ' ' + styles.activeTab}>
            <FileText size={14} /> Session Log
          </span>
        )}
      </div>

      {/* Sessions list */}
      {view === 'sessions' && (
        <div className={styles.list}>
          {sessions.map(session => (
            <div key={session.id} className={styles.sessionItem} onClick={() => viewSessionLog(session.id)}>
              <div className={styles.sessionHeader}>
                <span className={styles.sessionName}>{session.name}</span>
                <span className={`badge badge-${session.status}`}>{session.status}</span>
              </div>
              {session.summary && (
                <p className={styles.summary}>{session.summary}</p>
              )}
              <div className={styles.sessionMeta}>
                <span><MessageSquare size={11} /> {(session.user_message_count || 0) + (session.assistant_message_count || 0)} messages</span>
                <span><Clock size={11} /> {timeAgo(session.created_at)}</span>
              </div>
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="empty-state"><p>No session history yet</p></div>
          )}
        </div>
      )}

      {/* Search results */}
      {view === 'search' && searchResults && (
        <div className={styles.list}>
          {searchResults.map((result, i) => (
            <div key={i} className={styles.searchResult} onClick={() => viewSessionLog(result.session_id)}>
              <div className={styles.searchResultHeader}>
                <span className={styles.role}>{result.role}</span>
                <span className={styles.sessionName}>{result.session_name}</span>
                <span className={styles.time}>{formatDate(result.timestamp)}</span>
              </div>
              <p className={styles.searchContent}>{result.content.substring(0, 300)}</p>
            </div>
          ))}
          {searchResults.length === 0 && (
            <div className="empty-state"><p>No results found</p></div>
          )}
        </div>
      )}

      {/* Session log */}
      {view === 'log' && sessionLog && (
        <div className={styles.log}>
          <div className={styles.logHeader}>
            <button className="btn btn-ghost btn-sm" onClick={() => setView('sessions')}>
              <ArrowLeft size={14} /> Back
            </button>
            <h3>{sessionLog.session.name}</h3>
            <span className={styles.time}>{formatDate(sessionLog.session.created_at)}</span>
          </div>
          <div className={styles.logMessages}>
            {sessionLog.messages.map((msg, i) => (
              <div key={i} className={`${styles.logMessage} ${styles[msg.role]}`}>
                <span className={styles.logRole}>{msg.role}</span>
                <span className={styles.logTime}>{formatDate(msg.timestamp)}</span>
                <p className={styles.logContent}>{msg.content}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily digests */}
      {view === 'digests' && (
        <div className={styles.list}>
          <button className="btn btn-secondary btn-sm" onClick={generateDigest} style={{ marginBottom: 12 }}>
            Generate Today's Digest
          </button>
          {digests.map(digest => (
            <div key={digest.id} className={styles.digestItem}>
              <div className={styles.digestHeader}>
                <Calendar size={14} />
                <span className={styles.digestDate}>{digest.date}</span>
                <span className={styles.digestCount}>{digest.session_count} sessions</span>
              </div>
              <pre className={styles.digestContent}>{digest.content}</pre>
            </div>
          ))}
          {digests.length === 0 && (
            <div className="empty-state"><p>No digests yet</p></div>
          )}
        </div>
      )}
    </div>
  );
}
