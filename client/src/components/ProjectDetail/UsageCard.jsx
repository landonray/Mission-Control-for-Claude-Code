import React, { useEffect, useState } from 'react';
import { api } from '../../utils/api';
import styles from './UsageCard.module.css';

const LABELS = {
  planning: 'Planning',
  extraction: 'Extraction',
  eval_gatherer: 'Eval Gatherer',
};

function formatDuration(s) {
  if (!s) return '0s';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

export default function UsageCard({ projectId }) {
  const [stats, setStats] = useState([]);
  const [windowKey, setWindowKey] = useState('7d');

  useEffect(() => {
    let cancelled = false;
    api.get(`/api/planning/usage?project_id=${projectId}&window=${windowKey}`)
      .then((data) => { if (!cancelled) setStats(data.stats || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, windowKey]);

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span>Usage ({windowKey})</span>
        <select value={windowKey} onChange={(e) => setWindowKey(e.target.value)}>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="all">All time</option>
        </select>
      </div>
      {stats.length === 0 ? (
        <div className={styles.empty}>No planning, extraction, or eval-gatherer sessions yet.</div>
      ) : (
        <ul className={styles.list}>
          {stats.map((s) => (
            <li key={s.session_type} className={styles.row}>
              <span className={styles.type}>{LABELS[s.session_type] || s.session_type}</span>
              <span className={styles.count}>{s.session_count} sessions</span>
              <span className={styles.dur}>
                total {formatDuration(s.total_duration_seconds)} · avg {formatDuration(s.avg_duration_seconds)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
