import React from 'react';
import { timeAgo, getContextHealthLevel, getContextHealthLabel } from '../../utils/format';
import { MessageSquare, Wrench, GitBranch, Clock, Activity } from 'lucide-react';
import QualityScorecard from '../Quality/QualityScorecard';
import styles from './SessionCard.module.css';

export default function SessionCard({ session, onClick }) {
  const contextLevel = getContextHealthLevel(session.context_window_usage || 0);
  const contextPercent = Math.round((session.context_window_usage || 0) * 100);

  return (
    <div className={`card card-clickable ${styles.card}`} onClick={onClick}>
      <div className={styles.header}>
        <h3 className={styles.name}>{session.name}</h3>
        <span className={`badge badge-${session.status}`}>
          {session.status === 'working' && <Activity size={10} />}
          {session.status}
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
          <MessageSquare size={12} />
          <span>{session.user_message_count || 0}u / {session.assistant_message_count || 0}a</span>
        </div>
        <div className={styles.stat}>
          <Wrench size={12} />
          <span>{session.tool_call_count || 0} tools</span>
        </div>
        {session.branch && (
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
        <span className={styles.time}>
          <Clock size={11} />
          {timeAgo(session.last_activity_at)}
        </span>
      </div>
    </div>
  );
}
