import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../utils/api';
import { CheckCircle2, XCircle, HelpCircle, Loader2, ChevronDown, ChevronRight, Beaker } from 'lucide-react';
import styles from './TestRunsPanel.module.css';

export default function TestRunsPanel({ projectId }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(() => new Set());
  const wsRef = useRef(null);

  const loadRuns = useCallback(async () => {
    try {
      const data = await api.get(`/api/projects/${projectId}/test-runs?limit=50`);
      setRuns(data.runs || []);
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // Subscribe to live test_run events for this project.
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.type !== 'test_run_started' && data.type !== 'test_run_completed') return;
        if (data.projectId !== projectId) return;

        setRuns(prev => upsertRun(prev, data.run, data.type));
      } catch {
        // swallow
      }
    };
    return () => {
      try { ws.close(); } catch { /* swallow */ }
    };
  }, [projectId]);

  const toggle = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) {
    return <div className={styles.panel}><div className={styles.empty}>Loading test runs…</div></div>;
  }

  return (
    <div className={styles.panel}>
      <div className={styles.intro}>
        Test runs detected during your Claude Code sessions. Pass and fail counts
        are extracted from the runner's output. Click a failed run to see which
        tests failed and why.
      </div>

      {runs.length === 0 ? (
        <div className={styles.empty}>
          No test runs recorded yet. Once Claude runs <code>npm test</code>, <code>vitest</code>,
          {' '}<code>pytest</code>, or another supported test runner during a session, results
          will appear here.
        </div>
      ) : (
        <ul className={styles.runList}>
          {runs.map(run => (
            <RunRow
              key={run.id}
              run={run}
              expanded={expanded.has(run.id)}
              onToggle={() => toggle(run.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function upsertRun(prev, incoming, eventType) {
  if (!incoming || !incoming.id) return prev;
  const idx = prev.findIndex(r => r.id === incoming.id);
  if (idx === -1) {
    if (eventType === 'test_run_started') {
      return [incoming, ...prev];
    }
    return prev;
  }
  const next = [...prev];
  next[idx] = { ...next[idx], ...incoming };
  return next;
}

function RunRow({ run, expanded, onToggle }) {
  const failed = Array.isArray(run.failures) ? run.failures : (run.failures ? safeParseFailures(run.failures) : []);
  const canExpand = run.status === 'failed' || run.status === 'unknown' || failed.length > 0;
  return (
    <li className={`${styles.runItem} ${canExpand ? styles.runItemClickable : ''}`}>
      <div
        className={styles.runHeader}
        onClick={canExpand ? onToggle : undefined}
        role={canExpand ? 'button' : undefined}
        tabIndex={canExpand ? 0 : undefined}
      >
        <StatusBadge status={run.status} />
        <div className={styles.runMain}>
          <div className={styles.runCommandRow}>
            <Beaker size={12} />
            <code className={styles.runCommand}>{run.command}</code>
          </div>
          <div className={styles.runMeta}>
            {run.framework && <span className={styles.framework}>{run.framework}</span>}
            <RunCounts run={run} />
            <span className={styles.runTime}>{formatTime(run.created_at)}</span>
          </div>
        </div>
        {canExpand && (
          <span className={styles.chevron}>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        )}
      </div>
      {expanded && (
        <div className={styles.runDetails}>
          {failed.length === 0 ? (
            <div className={styles.detailsEmpty}>
              {run.status === 'parsing'
                ? 'Parsing output…'
                : 'No individual failures were extracted from the output.'}
            </div>
          ) : (
            <ul className={styles.failureList}>
              {failed.map((f, i) => (
                <li key={i} className={styles.failureItem}>
                  <div className={styles.failureName}>{f.name}</div>
                  {f.file && <div className={styles.failureFile}>{f.file}</div>}
                  {f.message && <div className={styles.failureMessage}>{f.message}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function StatusBadge({ status }) {
  if (status === 'passed') {
    return <span className={`${styles.badge} ${styles.badgePassed}`} title="All tests passed"><CheckCircle2 size={14} /></span>;
  }
  if (status === 'failed') {
    return <span className={`${styles.badge} ${styles.badgeFailed}`} title="At least one test failed"><XCircle size={14} /></span>;
  }
  if (status === 'parsing') {
    return <span className={`${styles.badge} ${styles.badgeParsing}`} title="Parsing output"><Loader2 size={14} className={styles.spin} /></span>;
  }
  return <span className={`${styles.badge} ${styles.badgeUnknown}`} title="Result unclear"><HelpCircle size={14} /></span>;
}

function RunCounts({ run }) {
  if (run.status === 'parsing') return <span className={styles.runCountsMuted}>parsing…</span>;
  const parts = [];
  if (typeof run.passed === 'number') parts.push(`${run.passed} passed`);
  if (typeof run.failed === 'number' && run.failed > 0) parts.push(`${run.failed} failed`);
  if (parts.length === 0 && typeof run.total === 'number') parts.push(`${run.total} tests`);
  if (parts.length === 0) return null;
  return <span className={styles.runCounts}>{parts.join(' · ')}</span>;
}

function safeParseFailures(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value) || []; } catch { return []; }
  }
  return [];
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleString();
}
