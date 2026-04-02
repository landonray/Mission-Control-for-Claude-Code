import React from 'react';
import { timeAgo, getContextHealthLevel, getContextHealthLabel } from '../../utils/format';
import { GitBranch, Clock, Activity, Cpu, Archive, ArchiveRestore, Plus, Minus } from 'lucide-react';
import QualityScorecard from '../Quality/QualityScorecard';
import styles from './SessionCard.module.css';

export default function SessionCard({ session, onClick, onArchive }) {
  const contextLevel = getContextHealthLevel(session.context_window_usage || 0);
  const contextPercent = Math.round((session.context_window_usage || 0) * 100);

  const cardClass = [
    'card card-clickable',
    styles.card,
    session.status === 'working' ? styles.cardWorking : '',
    session.status === 'waiting' ? styles.cardWaiting : '',
    session.archived ? styles.cardArchived : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cardClass} onClick={onClick}>
      <div className={styles.header}>
        <h3 className={styles.name}>{session.name}</h3>
        {session.model && session.model !== 'claude-opus-4-6' && (
          <span className={`badge ${styles.modelBadge}`}>
            <Cpu size={10} />
            {session.model.includes('sonnet') ? 'Sonnet' : session.model}
          </span>
        )}
        <span className={`badge badge-${session.archived ? 'ended' : session.status}`}>
          {session.status === 'working' && <Activity size={10} />}
          {session.archived ? 'archived' : session.status}
        </span>
      </div>

      {/* Context Window Health Meter */}
      <div className={styles.contextMeter}>
        <div className={styles.contextBar}>
          <div
            className={`${styles.contextFill} context-${contextLevel}`}
            style={{
              width: `${contextPercent}%`,
              backgroundColor: contextLevel === 'light' ? 'var(--success)'
                : contextLevel === 'moderate' ? 'var(--warning)'
                : contextLevel === 'heavy' ? '#f97316'
                : 'var(--error)'
            }}
          />
        </div>
        <span className={`${styles.contextLabel} context-${contextLevel}`}>
          {getContextHealthLabel(session.context_window_usage || 0)} ({contextPercent}%)
        </span>
      </div>

      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.diffAdded}>+{session.lines_added || 0}</span>
          <span className={styles.diffRemoved}>-{session.lines_removed || 0}</span>
        </div>
        {session.worktree_name && (
          <div className={styles.stat} title="Worktree">
            <GitBranch size={12} />
            <span>{session.worktree_name}</span>
          </div>
        )}
        {!session.worktree_name && session.branch && (
          <div className={styles.stat}>
            <GitBranch size={12} />
            <span>{session.branch}</span>
          </div>
        )}
      </div>

      {session.last_action_summary && (
        <p className={styles.summary}>{session.last_action_summary}</p>
      )}

      {/* Quality Scorecard */}
      <div onClick={e => e.stopPropagation()}>
        <QualityScorecard sessionId={session.id} />
      </div>

      <div className={styles.footer}>
        {(session.status === 'ended' || session.archived) && onArchive && (
          <button
            className={styles.archiveBtn}
            onClick={(e) => {
              e.stopPropagation();
              onArchive(session.id, !session.archived);
            }}
            title={session.archived ? 'Unarchive session' : 'Archive session'}
          >
            {session.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
          </button>
        )}
        <span className={styles.time}>
          <Clock size={11} />
          {timeAgo(session.last_activity_at)}
        </span>
      </div>
    </div>
  );
}
