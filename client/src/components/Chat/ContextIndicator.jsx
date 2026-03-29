import React from 'react';
import { getContextHealthLevel, getContextHealthLabel } from '../../utils/format';
import styles from './ContextIndicator.module.css';

export default function ContextIndicator({ usage }) {
  const level = getContextHealthLevel(usage);
  const percent = Math.round(usage * 100);

  const colors = {
    'light': 'var(--success)',
    'moderate': 'var(--warning)',
    'heavy': '#f97316',
    'very-heavy': 'var(--error)',
  };

  return (
    <div className={styles.indicator} title={`Context: ${getContextHealthLabel(usage)}`}>
      <div className={styles.bar}>
        <div
          className={styles.fill}
          style={{ width: `${percent}%`, backgroundColor: colors[level] }}
        />
      </div>
      <span className={styles.label} style={{ color: colors[level] }}>
        {percent}%
      </span>
    </div>
  );
}
