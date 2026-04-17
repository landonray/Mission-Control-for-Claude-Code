import React from 'react';
import styles from './PillSelector.module.css';

export default function PillSelector({ options, value, onChange }) {
  return (
    <div className={styles.pillGroup}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`${styles.pill} ${value === opt.value ? styles.active : ''}`}
          onClick={() => !opt.disabled && onChange(opt.value)}
          disabled={!!opt.disabled}
          title={opt.title}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
