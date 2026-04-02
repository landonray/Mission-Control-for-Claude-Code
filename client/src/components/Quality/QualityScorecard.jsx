import React, { useState, useEffect } from 'react';
import { api } from '../../utils/api';
import { Shield, CheckCircle, XCircle, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import styles from './QualityScorecard.module.css';

const severityColors = {
  high: 'var(--error)',
  medium: 'var(--warning)',
  low: 'var(--text-muted)',
};

export default function QualityScorecard({ sessionId }) {
  const [data, setData] = useState(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!sessionId) return;
    loadScorecard();
    const interval = setInterval(loadScorecard, 60000);
    return () => clearInterval(interval);
  }, [sessionId]);

  const loadScorecard = async () => {
    try {
      const result = await api.get(`/api/quality/results/scorecard/${sessionId}`);
      setData(result);
    } catch (e) {
      console.error('[QualityScorecard] Failed to load scorecard:', e.message);
    }
  };

  if (!data || data.rules.length === 0) return null;

  const { summary, rules } = data;

  return (
    <div className={styles.scorecard}>
      <button
        className={styles.header}
        onClick={() => setExpanded(!expanded)}
      >
        <Shield size={14} />
        <span className={styles.title}>Quality</span>

        <div className={styles.dots}>
          {rules.map((r, i) => (
            <span
              key={i}
              className={`${styles.dot} ${r.result === 'pass' ? styles.pass : styles.fail}`}
              title={`${r.rule_name}: ${r.result}`}
            />
          ))}
        </div>

        <span className={styles.passRate} style={{
          color: summary.passRate >= 80 ? 'var(--success)'
            : summary.passRate >= 50 ? 'var(--warning)'
            : 'var(--error)'
        }}>
          {summary.passRate}%
        </span>

        {summary.fails > 0 && (
          <span className={styles.failBadge}>
            {summary.fails} issue{summary.fails > 1 ? 's' : ''}
          </span>
        )}

        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>

      {expanded && (
        <div className={styles.details}>
          {rules.map((rule, i) => (
            <div key={i} className={styles.ruleResult}>
              {rule.result === 'pass'
                ? <CheckCircle size={14} className={styles.passIcon} />
                : <XCircle size={14} className={styles.failIcon} />
              }
              <div className={styles.ruleInfo}>
                <span className={styles.ruleName}>{rule.display_name || rule.rule_name}</span>
                {rule.details && (
                  <span className={styles.ruleDetails}>{rule.details}</span>
                )}
              </div>
              <span
                className={styles.severityBadge}
                style={{ color: severityColors[rule.severity || rule.rule_severity] }}
              >
                {rule.severity || rule.rule_severity}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
