import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../utils/api';
import {
  ChevronDown,
  ChevronRight,
  Shield,
  FolderOpen,
  Clock,
  Play,
  CheckCircle,
  XCircle,
  AlertTriangle,
  FileText,
} from 'lucide-react';
import styles from './QualityTab.module.css';

const severityColors = {
  high: 'var(--error)',
  medium: 'var(--warning)',
  low: 'var(--text-muted)',
};

const resultColors = {
  pass: 'var(--success)',
  fail: 'var(--error)',
  low_confidence: 'var(--warning)',
  error: 'var(--text-muted)',
};

function Toggle({ on, onChange, small }) {
  return (
    <button
      className={`${styles.toggleBtn} ${on ? styles.on : styles.off} ${small ? styles.small : ''}`}
      onClick={onChange}
      type="button"
    >
      <span className={styles.toggleTrack}>
        <span className={styles.toggleThumb} />
      </span>
    </button>
  );
}

function CollapsibleSection({ title, icon: Icon, defaultOpen = false, count, children }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={styles.section}>
      <button className={styles.sectionHeader} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {Icon && <Icon size={14} />}
        <span className={styles.sectionTitle}>{title}</span>
        {count != null && <span className={styles.sectionCount}>{count}</span>}
      </button>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </div>
  );
}

function TriggerPill({ label }) {
  return <span className={styles.triggerPill}>{label.replace('_', ' ')}</span>;
}

function SeverityBadge({ severity }) {
  return (
    <span className={styles.severityBadge} style={{ color: severityColors[severity] || 'var(--text-muted)' }}>
      {severity}
    </span>
  );
}

function StatusDot({ result }) {
  return (
    <span
      className={styles.statusDot}
      style={{ background: resultColors[result] || 'var(--text-muted)' }}
      title={result}
    />
  );
}

export default function QualityTab({ sessionId }) {
  const [project, setProject] = useState(null);
  const [noProject, setNoProject] = useState(false);
  const [rules, setRules] = useState([]);
  const [folders, setFolders] = useState([]);
  const [history, setHistory] = useState([]);
  const [expandedFolders, setExpandedFolders] = useState({});
  const [expandedBatches, setExpandedBatches] = useState({});
  const [batchRuns, setBatchRuns] = useState({});
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadProject = useCallback(async () => {
    if (!sessionId) return;
    try {
      const result = await api.get(`/api/projects/by-session/${sessionId}`);
      if (result && result.id) {
        setProject(result);
        setNoProject(false);
      } else {
        setProject(null);
        setNoProject(true);
      }
    } catch {
      setProject(null);
      setNoProject(true);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const loadRules = useCallback(async () => {
    try {
      const result = await api.get('/api/quality/rules');
      setRules(Array.isArray(result) ? result : []);
    } catch {
      setRules([]);
    }
  }, []);

  const loadFolders = useCallback(async () => {
    if (!project?.id) return;
    try {
      const result = await api.get(`/api/evals/folders/${project.id}`);
      setFolders(Array.isArray(result) ? result : []);
    } catch {
      setFolders([]);
    }
  }, [project?.id]);

  const loadHistory = useCallback(async () => {
    if (!project?.id) return;
    try {
      const result = await api.get(`/api/evals/history/${project.id}`);
      setHistory(Array.isArray(result) ? result : []);
    } catch {
      setHistory([]);
    }
  }, [project?.id]);

  useEffect(() => { loadProject(); }, [loadProject]);
  useEffect(() => { if (project) { loadRules(); loadFolders(); loadHistory(); } }, [project, loadRules, loadFolders, loadHistory]);

  const handleArm = async (folder) => {
    try {
      if (folder.armed) {
        await api.post(`/api/evals/folders/${project.id}/disarm`, { folder_path: folder.folder_path });
      } else {
        await api.post(`/api/evals/folders/${project.id}/arm`, { folder_path: folder.folder_path, folder_name: folder.folder_name });
      }
      loadFolders();
    } catch (err) {
      console.error('[QualityTab] Failed to toggle arm state:', err);
    }
  };

  const handleAutoSend = async (folder) => {
    try {
      await api.put(`/api/evals/folders/${project.id}/settings`, {
        folder_path: folder.folder_path,
        auto_send: !folder.auto_send,
      });
      loadFolders();
    } catch (err) {
      console.error('[QualityTab] Failed to update auto-send:', err);
    }
  };

  const handleTriggerToggle = async (folder, trigger) => {
    // triggers is stored as comma-separated string in DB, parse to array for manipulation
    const current = typeof folder.triggers === 'string'
      ? folder.triggers.split(',').filter(Boolean)
      : (folder.triggers || []);
    const updated = current.includes(trigger)
      ? current.filter(t => t !== trigger)
      : [...current, trigger];
    try {
      await api.put(`/api/evals/folders/${project.id}/settings`, {
        folder_path: folder.folder_path,
        triggers: updated.join(','),
      });
      loadFolders();
    } catch (err) {
      console.error('[QualityTab] Failed to toggle trigger:', err);
    }
  };

  const handleRunEvals = async () => {
    if (!project?.id) return;
    setRunning(true);
    try {
      await api.post(`/api/evals/run/${project.id}`);
      loadHistory();
    } catch (err) {
      console.error('[QualityTab] Failed to run evals:', err);
    }
    setRunning(false);
  };

  const toggleFolderExpand = (path) => {
    setExpandedFolders(prev => ({ ...prev, [path]: !prev[path] }));
  };

  const toggleBatchExpand = async (batchId) => {
    const wasOpen = expandedBatches[batchId];
    setExpandedBatches(prev => ({ ...prev, [batchId]: !wasOpen }));
    if (!wasOpen && !batchRuns[batchId]) {
      try {
        const runs = await api.get(`/api/evals/batch/${batchId}`);
        setBatchRuns(prev => ({ ...prev, [batchId]: runs }));
      } catch (err) {
        console.error('[QualityTab] Failed to load batch runs:', err);
      }
    }
  };

  if (loading) {
    return <div className={styles.container}><div className={styles.emptyState}>Loading...</div></div>;
  }

  if (noProject || !project) {
    return (
      <div className={styles.container}>
        <div className={styles.emptyState}>
          <Shield size={24} />
          <p>No project linked to this session. Add a .mission-control.yaml to your project root.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.topBar}>
        <button
          className={styles.runButton}
          onClick={handleRunEvals}
          disabled={running}
        >
          <Play size={14} />
          {running ? 'Running...' : 'Run Armed Evals'}
        </button>
      </div>

      <CollapsibleSection title="Quality Rules" icon={Shield} count={rules.length}>
        {rules.length === 0 ? (
          <div className={styles.emptySection}>No quality rules configured</div>
        ) : (
          rules.map((rule, i) => (
            <div key={rule.id || i} className={`${styles.ruleCard} ${rule.enabled === false ? styles.disabled : ''}`}>
              <div className={styles.ruleRow}>
                <span className={styles.ruleName}>{rule.display_name || rule.name}</span>
                <SeverityBadge severity={rule.severity} />
                <span className={`${styles.statusLabel} ${rule.enabled !== false ? styles.enabled : styles.disabledLabel}`}>
                  {rule.enabled !== false ? 'enabled' : 'disabled'}
                </span>
              </div>
              {rule.description && <div className={styles.ruleDescription}>{rule.description}</div>}
            </div>
          ))
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Eval Folders" icon={FolderOpen} count={folders.length} defaultOpen>
        {folders.length === 0 ? (
          <div className={styles.emptySection}>No eval folders discovered</div>
        ) : (
          folders.map((folder, i) => (
            <div key={folder.folder_path || i} className={styles.folderCard}>
              <div className={styles.folderHeader}>
                <Toggle on={folder.armed} onChange={() => handleArm(folder)} />
                <button
                  className={styles.folderExpand}
                  onClick={() => toggleFolderExpand(folder.folder_path)}
                >
                  {expandedFolders[folder.folder_path] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <div className={styles.folderInfo}>
                  <span className={styles.folderName}>{folder.name || folder.folder_path}</span>
                  {folder.eval_count != null && (
                    <span className={styles.evalCount}>{folder.eval_count} eval{folder.eval_count !== 1 ? 's' : ''}</span>
                  )}
                </div>
                <div className={styles.folderActions}>
                  {(typeof folder.triggers === 'string' ? folder.triggers.split(',').filter(Boolean) : (folder.triggers || [])).map(t => (
                    <TriggerPill key={t} label={t} />
                  ))}
                  <div className={styles.autoSendWrap}>
                    <span className={styles.autoSendLabel}>auto-send</span>
                    <Toggle on={folder.auto_send} onChange={() => handleAutoSend(folder)} small />
                  </div>
                </div>
              </div>
              {expandedFolders[folder.folder_path] && folder.evals && (
                <div className={styles.evalList}>
                  {folder.evals.map((ev, j) => (
                    <div key={ev.id || j} className={styles.evalItem}>
                      <FileText size={12} />
                      <div className={styles.evalInfo}>
                        <span className={styles.evalName}>{ev.name}</span>
                        {ev.evidence_type && <span className={styles.evalMeta}>{ev.evidence_type}</span>}
                        {ev.description && <span className={styles.evalDescription}>{ev.description}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Run History" icon={Clock} count={history.length}>
        {history.length === 0 ? (
          <div className={styles.emptySection}>No eval runs yet</div>
        ) : (
          history.map((batch, i) => (
            <div key={batch.id || i} className={styles.batchCard}>
              <button
                className={styles.batchHeader}
                onClick={() => toggleBatchExpand(batch.id)}
              >
                {expandedBatches[batch.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <div className={styles.batchInfo}>
                  <span className={styles.batchTrigger}>{batch.trigger_source || 'manual'}</span>
                  {batch.commit_sha && (
                    <span className={styles.batchSha}>{batch.commit_sha.slice(0, 7)}</span>
                  )}
                  <span className={styles.batchTime}>
                    {new Date(batch.started_at).toLocaleString()}
                  </span>
                </div>
                <div className={styles.batchCounts}>
                  {batch.passed > 0 && <span className={styles.countPass}>{batch.passed} pass</span>}
                  {batch.failed > 0 && <span className={styles.countFail}>{batch.failed} fail</span>}
                  {batch.errors > 0 && <span className={styles.countError}>{batch.errors} error</span>}
                </div>
              </button>
              {expandedBatches[batch.id] && batchRuns[batch.id] && (
                <div className={styles.batchRuns}>
                  {(Array.isArray(batchRuns[batch.id]) ? batchRuns[batch.id] : []).map((run, j) => (
                    <div key={run.id || j} className={styles.runRow}>
                      <StatusDot result={run.state} />
                      <span className={styles.runName}>{run.eval_name || run.name}</span>
                      <span className={styles.runResult}>{run.state}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </CollapsibleSection>
    </div>
  );
}
