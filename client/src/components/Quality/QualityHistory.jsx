import React, { useState, useEffect } from 'react';
import { api } from '../../utils/api';
import {
  BarChart3, TrendingUp, AlertTriangle, CheckCircle, XCircle,
  Shield, ArrowLeft, Calendar
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import styles from './QualityHistory.module.css';

export default function QualityHistory() {
  const [analytics, setAnalytics] = useState(null);
  const [recentResults, setRecentResults] = useState([]);
  const [days, setDays] = useState(30);
  const [filterResult, setFilterResult] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    loadAnalytics();
    loadRecentResults();
  }, [days, filterResult]);

  const loadAnalytics = async () => {
    try {
      const data = await api.get(`/api/quality/analytics?days=${days}`);
      setAnalytics(data);
    } catch (e) {}
  };

  const loadRecentResults = async () => {
    try {
      const url = `/api/quality/results?limit=50${filterResult ? `&result=${filterResult}` : ''}`;
      const data = await api.get(url);
      setRecentResults(data);
    } catch (e) {}
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/settings')}>
          <ArrowLeft size={14} /> Settings
        </button>
        <h1><BarChart3 size={20} /> Quality Analytics</h1>
        <select
          className="input"
          value={days}
          onChange={e => setDays(parseInt(e.target.value))}
          style={{ width: 'auto', padding: '4px 8px', fontSize: 13 }}
        >
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {analytics && (
        <>
          {/* Overview stats */}
          <div className={styles.statsGrid}>
            <div className={styles.statCard}>
              <div className={styles.statValue}>{analytics.overall.total_checks}</div>
              <div className={styles.statLabel}>Total Checks</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statValue} style={{ color: 'var(--success)' }}>
                {analytics.overall.passRate}%
              </div>
              <div className={styles.statLabel}>Pass Rate</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statValue} style={{ color: 'var(--error)' }}>
                {analytics.overall.total_fails}
              </div>
              <div className={styles.statLabel}>Total Fails</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statValue}>{analytics.overall.sessions_checked}</div>
              <div className={styles.statLabel}>Sessions Checked</div>
            </div>
          </div>

          {/* Pass rate trend */}
          {analytics.dailyTrend.length > 0 && (
            <div className={styles.section}>
              <h3><TrendingUp size={16} /> Pass Rate Trend</h3>
              <div className={styles.trendChart}>
                {analytics.dailyTrend.map((day, i) => (
                  <div key={i} className={styles.trendBar} title={`${day.date}: ${day.pass_rate}% (${day.passes}/${day.total})`}>
                    <div className={styles.barContainer}>
                      <div
                        className={styles.barFill}
                        style={{
                          height: `${day.pass_rate || 0}%`,
                          backgroundColor: day.pass_rate >= 80 ? 'var(--success)'
                            : day.pass_rate >= 50 ? 'var(--warning)'
                            : 'var(--error)'
                        }}
                      />
                    </div>
                    <span className={styles.barLabel}>
                      {new Date(day.date).toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Most triggered rules */}
          {analytics.mostTriggered.length > 0 && (
            <div className={styles.section}>
              <h3><Shield size={16} /> Most Triggered Rules</h3>
              <div className={styles.rulesList}>
                {analytics.mostTriggered.map((rule, i) => {
                  const passRate = rule.count > 0 ? Math.round((rule.passes / rule.count) * 100) : 0;
                  return (
                    <div key={i} className={styles.ruleRow}>
                      <span className={styles.ruleRank}>#{i + 1}</span>
                      <span className={styles.ruleRowName}>{rule.rule_name}</span>
                      <span className={styles.ruleCount}>{rule.count} checks</span>
                      <div className={styles.miniBar}>
                        <div
                          className={styles.miniBarFill}
                          style={{
                            width: `${passRate}%`,
                            backgroundColor: passRate >= 80 ? 'var(--success)' : passRate >= 50 ? 'var(--warning)' : 'var(--error)'
                          }}
                        />
                      </div>
                      <span className={styles.rulePassRate}>{passRate}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Most blocking rules */}
          {analytics.mostBlocking.length > 0 && (
            <div className={styles.section}>
              <h3><AlertTriangle size={16} /> Most Blocking Rules</h3>
              <div className={styles.rulesList}>
                {analytics.mostBlocking.map((rule, i) => (
                  <div key={i} className={styles.ruleRow}>
                    <XCircle size={14} style={{ color: 'var(--error)', flexShrink: 0 }} />
                    <span className={styles.ruleRowName}>{rule.rule_name}</span>
                    <span className={styles.failCount}>{rule.fail_count} blocks</span>
                    <span className={styles.severityTag} style={{
                      color: rule.severity === 'high' ? 'var(--error)' : rule.severity === 'medium' ? 'var(--warning)' : 'var(--text-muted)'
                    }}>{rule.severity}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Recent results */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3><Calendar size={16} /> Recent Results</h3>
          <select
            className="input"
            value={filterResult}
            onChange={e => setFilterResult(e.target.value)}
            style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }}
          >
            <option value="">All</option>
            <option value="pass">Passes</option>
            <option value="fail">Fails</option>
          </select>
        </div>

        <div className={styles.resultsList}>
          {recentResults.map((result, i) => (
            <div key={i} className={styles.resultRow}>
              {result.result === 'pass'
                ? <CheckCircle size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />
                : <XCircle size={14} style={{ color: 'var(--error)', flexShrink: 0 }} />
              }
              <div className={styles.resultInfo}>
                <span className={styles.resultName}>{result.rule_name}</span>
                {result.details && (
                  <span className={styles.resultDetails}>{result.details}</span>
                )}
              </div>
              <span className={styles.resultTime}>
                {new Date(result.timestamp).toLocaleString()}
              </span>
            </div>
          ))}

          {recentResults.length === 0 && (
            <div className="empty-state" style={{ padding: '24px' }}>
              <p>No quality results yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
