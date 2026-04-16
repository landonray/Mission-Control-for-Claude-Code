import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../utils/api';
import {
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Shield,
  FolderOpen,
  Clock,
  Play,
  CheckCircle,
  XCircle,
  AlertTriangle,
  FileText,
  Plus,
} from 'lucide-react';
import styles from './QualityTab.module.css';
import CreateFolderModal from './CreateFolderModal';
import CreateEvalForm from './CreateEvalForm';

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

function CollapsibleSection({ title, icon: Icon, defaultOpen = false, count, bodyClassName, children }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={styles.section}>
      <button className={styles.sectionHeader} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {Icon && <Icon size={14} />}
        <span className={styles.sectionTitle}>{title}</span>
        {count != null && <span className={styles.sectionCount}>{count}</span>}
      </button>
      {open && <div className={bodyClassName || styles.sectionBody}>{children}</div>}
    </div>
  );
}

function TriggerPill({ label, onRemove }) {
  return (
    <span className={styles.triggerPill}>
      {label.replace('_', ' ')}
      {onRemove && (
        <button className={styles.triggerRemove} onClick={onRemove} title="Remove trigger">&times;</button>
      )}
    </span>
  );
}

const ALL_TRIGGERS = ['session_end', 'pr_updated'];

function TriggerAddButton({ currentTriggers, onAdd }) {
  const [open, setOpen] = useState(false);
  const available = ALL_TRIGGERS.filter(t => !currentTriggers.includes(t));
  if (available.length === 0) return null;

  return (
    <div className={styles.triggerAddWrap}>
      <button className={styles.triggerAddBtn} onClick={() => setOpen(!open)} title="Add trigger">+</button>
      {open && (
        <div className={styles.triggerDropdown}>
          {available.map(t => (
            <button key={t} className={styles.triggerOption} onClick={() => { onAdd(t); setOpen(false); }}>
              {t.replace('_', ' ')}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SeverityBadge({ severity }) {
  return (
    <span className={styles.severityBadge} style={{ color: severityColors[severity] || 'var(--text-muted)' }}>
      {severity}
    </span>
  );
}

function safeParseJson(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return null; }
}

function isLowConfidence(run) {
  const verdict = safeParseJson(run.judge_verdict);
  return verdict && verdict.confidence === 'low';
}

function effectiveResult(run) {
  if (run.state === 'pass' && isLowConfidence(run)) return 'low_confidence';
  return run.state;
}

function RunDetailView({ run, onBack }) {
  const evidence = safeParseJson(run.evidence);
  const checkResults = safeParseJson(run.check_results);
  const judgeVerdict = safeParseJson(run.judge_verdict);
  const input = safeParseJson(run.input);
  const displayResult = effectiveResult(run);

  return (
    <div className={styles.drillDown}>
      <button className={styles.backButton} onClick={onBack}>
        <ChevronLeft size={14} />
        Back
      </button>
      <div className={styles.drillDownHeader}>
        <h3 className={styles.drillDownTitle}>{run.eval_name}</h3>
        <StatusDot result={displayResult} />
        <span className={styles.drillDownState}>{displayResult === 'low_confidence' ? 'pass (low confidence)' : run.state}</span>
      </div>
      <div className={styles.drillDownMeta}>
        {run.commit_sha && <span className={styles.batchSha}>{run.commit_sha.slice(0, 7)}</span>}
        {run.timestamp && <span className={styles.drillDownTime}>{new Date(run.timestamp).toLocaleString()}</span>}
        {run.duration > 0 && <span className={styles.drillDownDuration}>{(run.duration / 1000).toFixed(1)}s</span>}
      </div>

      {run.fail_reason && (
        <div className={styles.detailSection}>
          <div className={styles.detailLabel}>Failure Reason</div>
          <div className={styles.detailError}>{run.fail_reason}</div>
        </div>
      )}
      {run.error_message && (
        <div className={styles.detailSection}>
          <div className={styles.detailLabel}>Error</div>
          <div className={styles.detailError}>{run.error_message}</div>
        </div>
      )}

      {input && Object.keys(input).length > 0 && (
        <div className={styles.detailSection}>
          <div className={styles.detailLabel}>Input</div>
          <pre className={styles.detailPre}>{JSON.stringify(input, null, 2)}</pre>
        </div>
      )}

      {evidence && (
        <div className={styles.detailSection}>
          <div className={styles.detailLabel}>Evidence</div>
          <pre className={styles.detailPre}>
            {typeof evidence === 'string' ? evidence : JSON.stringify(evidence, null, 2)}
          </pre>
        </div>
      )}

      {checkResults && (
        <div className={styles.detailSection}>
          <div className={styles.detailLabel}>Check Results</div>
          {Array.isArray(checkResults.results) ? (
            <div className={styles.checkList}>
              {checkResults.results.map((cr, i) => (
                <div key={i} className={`${styles.checkItem} ${cr.passed ? styles.checkPass : styles.checkFail}`}>
                  <StatusDot result={cr.passed ? 'pass' : 'fail'} />
                  <span className={styles.checkType}>{cr.type}</span>
                  {cr.description && <span className={styles.checkDesc}>{cr.description}</span>}
                  {cr.reason && !cr.passed && <span className={styles.checkReason}>{cr.reason}</span>}
                </div>
              ))}
            </div>
          ) : (
            <pre className={styles.detailPre}>{JSON.stringify(checkResults, null, 2)}</pre>
          )}
        </div>
      )}

      {judgeVerdict && (
        <div className={styles.detailSection}>
          <div className={styles.detailLabel}>Judge Verdict</div>
          <div className={styles.judgeVerdict}>
            <div className={styles.judgeRow}>
              <StatusDot result={judgeVerdict.result === 'pass' ? 'pass' : 'fail'} />
              <span className={styles.judgeResult}>{judgeVerdict.result === 'pass' ? 'Pass' : 'Fail'}</span>
              {judgeVerdict.confidence && (
                <span className={styles.judgeConfidence}>{judgeVerdict.confidence} confidence</span>
              )}
            </div>
            {judgeVerdict.reasoning && (
              <div className={styles.judgeReasoning}>{judgeVerdict.reasoning}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EvalHistoryView({ evalName, runs, loading: isLoading, onBack, onRunClick }) {
  return (
    <div className={styles.drillDown}>
      <button className={styles.backButton} onClick={onBack}>
        <ChevronLeft size={14} />
        Back to folders
      </button>
      <div className={styles.drillDownHeader}>
        <FileText size={16} />
        <h3 className={styles.drillDownTitle}>{evalName}</h3>
        <span className={styles.sectionCount}>{runs.length} run{runs.length !== 1 ? 's' : ''}</span>
      </div>
      {isLoading ? (
        <div className={styles.emptySection}>Loading run history...</div>
      ) : runs.length === 0 ? (
        <div className={styles.emptySection}>No runs found for this eval</div>
      ) : (
        <div className={styles.evalRunsList}>
          {runs.map((run, i) => {
            const display = effectiveResult(run);
            return (
            <button
              key={run.id || i}
              className={styles.evalRunRow}
              onClick={() => onRunClick(run)}
            >
              <StatusDot result={display} />
              <span className={styles.evalRunState}>{display === 'low_confidence' ? 'low conf' : run.state}</span>
              {run.commit_sha && <span className={styles.batchSha}>{run.commit_sha.slice(0, 7)}</span>}
              <span className={styles.evalRunTime}>{new Date(run.timestamp).toLocaleString()}</span>
              {run.duration > 0 && <span className={styles.evalRunDuration}>{(run.duration / 1000).toFixed(1)}s</span>}
              <ChevronRight size={12} className={styles.evalRunArrow} />
            </button>
            );
          })}
        </div>
      )}
    </div>
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
  const [runningRules, setRunningRules] = useState({});
  const [loading, setLoading] = useState(true);
  // Drill-down state for eval run history (item 15)
  const [selectedEval, setSelectedEval] = useState(null); // { name, projectId }
  const [evalRuns, setEvalRuns] = useState([]);
  const [evalRunsLoading, setEvalRunsLoading] = useState(false);
  // Drill-down state for single run detail (item 16)
  const [selectedRun, setSelectedRun] = useState(null); // full run object
  const [selectedRunLoading, setSelectedRunLoading] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [createEvalTarget, setCreateEvalTarget] = useState(null);

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
      // Use per-project resolved rules when a project is available (3-tier priority chain)
      const url = project?.id
        ? `/api/quality/rules/project/${project.id}`
        : '/api/quality/rules';
      const result = await api.get(url);
      setRules(Array.isArray(result) ? result : []);
    } catch {
      setRules([]);
    }
  }, [project?.id]);

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

  useEffect(() => {
    if (!sessionId) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.hostname + ':3001';
    const ws = new WebSocket(`${protocol}//${wsHost}/ws`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe_session', sessionId }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'quality_result' && data.ruleId) {
          setRunningRules(prev => {
            if (prev[data.ruleId]) {
              const next = { ...prev };
              delete next[data.ruleId];
              return next;
            }
            return prev;
          });
        }
      } catch {
        // ignore
      }
    };

    return () => ws.close();
  }, [sessionId]);

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
        auto_send: folder.auto_send ? 0 : 1,
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

  const handleRuleToggle = async (rule) => {
    if (!project?.id) return;
    try {
      await api.post(`/api/quality/rules/project/${project.id}/override`, {
        rule_id: rule.id,
        enabled: rule.enabled ? false : true,
      });
      loadRules();
    } catch (err) {
      console.error('[QualityTab] Failed to toggle rule:', err);
    }
  };

  const handleResetRuleOverride = async (rule) => {
    if (!project?.id) return;
    try {
      await api.delete(`/api/quality/rules/project/${project.id}/override/${rule.id}`);
      loadRules();
    } catch (err) {
      console.error('[QualityTab] Failed to reset rule override:', err);
    }
  };

  const handleRunRule = async (rule) => {
    if (!sessionId || runningRules[rule.id]) return;
    setRunningRules(prev => ({ ...prev, [rule.id]: true }));
    try {
      await api.post(`/api/quality/rules/${rule.id}/run`, { sessionId });
    } catch (err) {
      console.error('[QualityTab] Failed to run rule:', err);
      setRunningRules(prev => {
        const next = { ...prev };
        delete next[rule.id];
        return next;
      });
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

  const handleEvalClick = async (evalName) => {
    if (!project?.id) return;
    setSelectedEval({ name: evalName, projectId: project.id });
    setSelectedRun(null);
    setEvalRunsLoading(true);
    try {
      const runs = await api.get(`/api/evals/eval-history/${project.id}/${encodeURIComponent(evalName)}`);
      setEvalRuns(Array.isArray(runs) ? runs : []);
    } catch {
      setEvalRuns([]);
    }
    setEvalRunsLoading(false);
  };

  const handleRunClick = async (run) => {
    // If the run object already has evidence/check_results, use it directly
    if (run.evidence || run.check_results || run.judge_verdict) {
      setSelectedRun(run);
      return;
    }
    // Otherwise fetch the full run detail
    setSelectedRunLoading(true);
    try {
      const full = await api.get(`/api/evals/run/${run.id}`);
      setSelectedRun(full);
    } catch {
      setSelectedRun(run); // fall back to what we have
    }
    setSelectedRunLoading(false);
  };

  const handleBackFromRun = () => {
    setSelectedRun(null);
  };

  const handleBackFromEval = () => {
    setSelectedEval(null);
    setEvalRuns([]);
    setSelectedRun(null);
  };

  const handleCreateFolder = async (folderName) => {
    const result = await api.post(`/api/evals/folders/${project.id}/create`, { folder_name: folderName });
    if (result.error) throw new Error(result.error);
    loadFolders();
  };

  const handleCreateEval = async (evalDef) => {
    const result = await api.post(`/api/evals/folders/${project.id}/create-eval`, evalDef);
    if (result.error) throw new Error(result.error);
    loadFolders();
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

  // Drill-down: run detail view
  if (selectedRun) {
    return (
      <div className={styles.container}>
        {selectedRunLoading ? (
          <div className={styles.emptyState}>Loading run details...</div>
        ) : (
          <RunDetailView
            run={selectedRun}
            onBack={handleBackFromRun}
          />
        )}
      </div>
    );
  }

  if (createEvalTarget) {
    return (
      <div className={styles.container}>
        <CreateEvalForm
          folderPath={createEvalTarget.folder_path}
          folderName={createEvalTarget.folder_name}
          onClose={() => setCreateEvalTarget(null)}
          onCreate={handleCreateEval}
        />
      </div>
    );
  }

  // Drill-down: eval run history view
  if (selectedEval) {
    return (
      <div className={styles.container}>
        <EvalHistoryView
          evalName={selectedEval.name}
          runs={evalRuns}
          loading={evalRunsLoading}
          onBack={handleBackFromEval}
          onRunClick={handleRunClick}
        />
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

      <CollapsibleSection title="Quality Rules" icon={Shield} count={rules.length} bodyClassName={styles.rulesBody}>
        {rules.length === 0 ? (
          <div className={styles.emptySection}>No quality rules configured</div>
        ) : (
          rules.map((rule, i) => (
            <div key={rule.id || i} className={`${styles.ruleCard} ${rule.enabled === false || rule.enabled === 0 ? styles.disabled : ''}`}>
              <div className={styles.ruleRow}>
                {project && <Toggle on={!!rule.enabled} onChange={() => handleRuleToggle(rule)} small />}
                <span className={styles.ruleName}>{rule.display_name || rule.name}</span>
                <SeverityBadge severity={rule.severity} />
                <span className={`${styles.statusLabel} ${rule.enabled ? styles.enabled : styles.disabledLabel}`}>
                  {rule.enabled ? 'enabled' : 'disabled'}
                </span>
                {rule.override_source && rule.override_source !== 'global' && (
                  <span className={styles.overrideBadge} title={`Override from ${rule.override_source}`}>
                    {rule.override_source}
                  </span>
                )}
                {project && rule.has_override && (
                  <button className={styles.resetBtn} onClick={() => handleResetRuleOverride(rule)} title="Reset to default">
                    &times;
                  </button>
                )}
                <button
                  className={`${styles.rulePlayBtn} ${runningRules[rule.id] ? styles.rulePlayRunning : ''}`}
                  onClick={() => handleRunRule(rule)}
                  disabled={!sessionId || runningRules[rule.id]}
                  title={runningRules[rule.id] ? 'Running...' : 'Run this rule now'}
                >
                  {runningRules[rule.id] ? <Clock size={12} className={styles.spinning} /> : <Play size={12} />}
                </button>
              </div>
              {rule.description && <div className={styles.ruleDescription}>{rule.description}</div>}
            </div>
          ))
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Eval Folders" icon={FolderOpen} count={folders.length} defaultOpen>
        <div className={styles.sectionActions}>
          <button className={styles.newFolderBtn} onClick={() => setShowCreateFolder(true)}>
            <Plus size={12} /> New Folder
          </button>
        </div>
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
                  <span className={styles.folderName}>{folder.folder_name || folder.name || folder.folder_path}</span>
                  {folder.eval_count != null && (
                    <span className={styles.evalCount}>{folder.eval_count} eval{folder.eval_count !== 1 ? 's' : ''}</span>
                  )}
                </div>
                <div className={styles.folderActions}>
                  {(typeof folder.triggers === 'string' ? folder.triggers.split(',').filter(Boolean) : (folder.triggers || [])).map(t => (
                    <TriggerPill key={t} label={t} onRemove={folder.armed ? () => handleTriggerToggle(folder, t) : undefined} />
                  ))}
                  {folder.armed && (
                    <TriggerAddButton
                      currentTriggers={typeof folder.triggers === 'string' ? folder.triggers.split(',').filter(Boolean) : (folder.triggers || [])}
                      onAdd={(t) => handleTriggerToggle(folder, t)}
                    />
                  )}
                  <div className={styles.autoSendWrap}>
                    <span className={styles.autoSendLabel}>auto-send</span>
                    <Toggle on={folder.auto_send} onChange={() => handleAutoSend(folder)} small />
                  </div>
                </div>
                {folder.last_run_status && folder.last_run_status.length > 0 && (
                  <div className={styles.statusDots}>
                    {folder.last_run_status.map((s, k) => (
                      <span
                        key={k}
                        className={styles.statusDot}
                        style={{ background: s.low_confidence ? resultColors.low_confidence : (resultColors[s.state] || 'var(--text-muted)') }}
                        title={`${s.eval_name}: ${s.low_confidence ? 'low confidence' : s.state}`}
                      />
                    ))}
                  </div>
                )}
              </div>
              {expandedFolders[folder.folder_path] && folder.evals && (
                <div className={styles.evalList}>
                  {folder.evals.map((ev, j) => (
                    <button
                      key={ev.id || j}
                      className={styles.evalItem}
                      onClick={() => handleEvalClick(ev.name)}
                    >
                      <FileText size={12} />
                      <div className={styles.evalInfo}>
                        <span className={styles.evalName}>{ev.name}</span>
                        {ev.evidence_type && <span className={styles.evalMeta}>{ev.evidence_type}</span>}
                        {ev.description && <span className={styles.evalDescription}>{ev.description}</span>}
                      </div>
                      <ChevronRight size={12} className={styles.evalRunArrow} />
                    </button>
                  ))}
                  <button
                    className={styles.newEvalBtn}
                    onClick={() => setCreateEvalTarget({ folder_path: folder.folder_path, folder_name: folder.folder_name || folder.folder_path })}
                  >
                    <Plus size={12} /> New Eval
                  </button>
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
                    <button
                      key={run.id || j}
                      className={styles.runRow}
                      onClick={() => handleRunClick(run)}
                    >
                      <StatusDot result={effectiveResult(run)} />
                      <span className={styles.runName}>{run.eval_name || run.name}</span>
                      <span className={styles.runResult}>{effectiveResult(run) === 'low_confidence' ? 'low conf' : run.state}</span>
                      <ChevronRight size={12} className={styles.evalRunArrow} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </CollapsibleSection>
      {showCreateFolder && (
        <CreateFolderModal
          onClose={() => setShowCreateFolder(false)}
          onCreate={handleCreateFolder}
        />
      )}
    </div>
  );
}
