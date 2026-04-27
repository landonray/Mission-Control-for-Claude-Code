import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import {
  BookOpen, FileText, Loader2, AlertTriangle, CheckCircle2,
  ChevronDown, ChevronRight, RefreshCw, X
} from 'lucide-react';
import styles from './ContextDocsPanel.module.css';

const PHASE_LABEL = {
  fetching: 'Fetching merged PRs',
  extracting: 'Analyzing PRs',
  rolling_up: 'Rolling up batches',
  finalizing: 'Writing PRODUCT.md and ARCHITECTURE.md',
  completed: 'Done',
  failed: 'Failed',
};

const TERMINAL = new Set(['completed', 'failed']);

export default function ContextDocsPanel({ projectId, githubRepo }) {
  const [run, setRun] = useState(null);
  const [files, setFiles] = useState({});
  const [loading, setLoading] = useState(true);
  const [logExpanded, setLogExpanded] = useState(false);
  const [logLines, setLogLines] = useState([]);
  const [showFile, setShowFile] = useState(null); // 'PRODUCT.md' | 'ARCHITECTURE.md' | null
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  const wsRef = useRef(null);

  const loadLatest = useCallback(async () => {
    try {
      const data = await api.get(`/api/projects/${projectId}/context-docs/latest`);
      setRun(data.run);
      setFiles(data.files || {});
      // Seed log lines from the run row so the live log isn't empty on refresh.
      if (data.run && Array.isArray(data.run.log_lines)) {
        setLogLines(data.run.log_lines);
      } else {
        setLogLines([]);
      }
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { loadLatest(); }, [loadLatest]);

  // Subscribe to live progress events for this project.
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (!data || data.projectId !== projectId) return;
        if (data.type === 'context_doc_run_started') {
          setRun(prev => ({ ...(prev || {}), ...data.run }));
          setLogLines([]);
        } else if (data.type === 'context_doc_run_progress') {
          setRun(prev => prev ? { ...prev, ...data.update } : prev);
        } else if (data.type === 'context_doc_run_log') {
          setLogLines(prev => [...prev, data.line].slice(-100));
        } else if (data.type === 'context_doc_run_completed') {
          setRun(data.run);
          // Pull in the new file metadata once a run finishes.
          loadLatest();
        }
      } catch { /* swallow */ }
    };
    return () => { try { ws.close(); } catch { /* swallow */ } };
  }, [projectId, loadLatest]);

  const handleGenerate = async () => {
    // Only confirm on a destructive first-time generate (overwrite). For
    // Retry/Resume after a failure, just kick it off — cached PR extractions
    // mean we're not re-doing expensive work, and confirm dialogs get
    // dismissed/auto-suppressed often enough to make the button feel broken.
    const isFreshOverwrite = !run || run.status === 'completed';
    if (isFreshOverwrite) {
      const ok = window.confirm(
        run
          ? 'Regenerate PRODUCT.md and ARCHITECTURE.md? This will overwrite the existing files.'
          : 'Generate PRODUCT.md and ARCHITECTURE.md from this project\'s GitHub PRs? This may take several minutes.'
      );
      if (!ok) return;
    }
    setStarting(true);
    setStartError(null);
    try {
      await api.post(`/api/projects/${projectId}/context-docs/generate`, {});
      await loadLatest();
    } catch (err) {
      setStartError(err.message || 'Failed to start generation. Check the server is running.');
    } finally {
      setStarting(false);
    }
  };

  const handleViewFile = async (name) => {
    if (showFile === name) {
      setShowFile(null);
      setFileContent('');
      return;
    }
    setShowFile(name);
    setFileLoading(true);
    setFileContent('');
    try {
      const data = await api.get(`/api/projects/${projectId}/context-docs/file?name=${encodeURIComponent(name)}`);
      setFileContent(data.content || '');
    } catch (err) {
      setFileContent(`Failed to load: ${err.message}`);
    } finally {
      setFileLoading(false);
    }
  };

  if (loading) {
    return <div className={styles.panel}><div className={styles.empty}>Loading…</div></div>;
  }

  const isRunning = run && !TERMINAL.has(run.status);
  const isFailed = run && run.status === 'failed';
  const isCompleted = run && run.status === 'completed';
  const isInterrupted = isFailed && /Interrupted by server restart/i.test(run?.error_message || '');

  return (
    <div className={styles.panel}>
      <div className={styles.intro}>
        Generate <code>PRODUCT.md</code> and <code>ARCHITECTURE.md</code> by analyzing every merged
        PR in <code>{githubRepo || 'this project'}</code>. Each PR is summarized, then the summaries
        are rolled up in batches into the two reference documents Mission Control loads at the start
        of every Claude session.
      </div>

      {!githubRepo && (
        <div className={styles.warning}>
          <AlertTriangle size={14} /> No GitHub repo is connected to this project. Set one in the
          project's git remote, then refresh.
        </div>
      )}

      {!run && githubRepo && (
        <IdleState
          starting={starting}
          startError={startError}
          onGenerate={handleGenerate}
          files={files}
          onViewFile={handleViewFile}
        />
      )}

      {run && (
        <RunPanel
          run={run}
          isRunning={isRunning}
          isFailed={isFailed}
          isCompleted={isCompleted}
          isInterrupted={isInterrupted}
          logLines={logLines}
          logExpanded={logExpanded}
          setLogExpanded={setLogExpanded}
          starting={starting}
          startError={startError}
          onGenerate={handleGenerate}
          files={files}
          onViewFile={handleViewFile}
        />
      )}

      {showFile && (
        <FilePreview
          name={showFile}
          loading={fileLoading}
          content={fileContent}
          onClose={() => { setShowFile(null); setFileContent(''); }}
        />
      )}
    </div>
  );
}

function IdleState({ starting, startError, onGenerate, files, onViewFile }) {
  const hasPrior = files['PRODUCT.md']?.exists || files['ARCHITECTURE.md']?.exists;
  return (
    <div className={styles.actionBlock}>
      <div className={styles.statusLine}>
        <span className={styles.muted}>Never generated</span>
      </div>
      <div className={styles.actions}>
        <button
          className="btn btn-primary btn-sm"
          onClick={onGenerate}
          disabled={starting}
        >
          <BookOpen size={14} /> {starting ? 'Starting…' : 'Generate Context Docs'}
        </button>
      </div>
      {startError && <div className={styles.errorBlock}>{startError}</div>}
      {hasPrior && (
        <FileLinksRow files={files} onViewFile={onViewFile} />
      )}
    </div>
  );
}

function RunPanel({
  run, isRunning, isFailed, isCompleted, isInterrupted,
  logLines, logExpanded, setLogExpanded,
  starting, startError, onGenerate, files, onViewFile,
}) {
  const retryLabel = isInterrupted ? 'Resume' : 'Retry';
  return (
    <div className={styles.actionBlock}>
      <div className={styles.statusRow}>
        <PhaseBadge status={run.status} phase={run.phase} />
        <PhaseProgress run={run} />
      </div>

      {isFailed && run.error_message && (
        <div className={styles.errorBlock}>
          <strong>Error:</strong> {run.error_message}
        </div>
      )}

      {(isRunning || logLines.length > 0) && (
        <div className={styles.logBlock}>
          <button
            type="button"
            className={styles.logToggle}
            onClick={() => setLogExpanded(v => !v)}
          >
            {logExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {logExpanded ? 'Hide live log' : `Show live log (${logLines.length} lines)`}
          </button>
          {logExpanded && (
            <pre className={styles.logPre}>
              {logLines.length === 0 ? '(no log lines yet)' : logLines.join('\n')}
            </pre>
          )}
        </div>
      )}

      {isCompleted && (
        <div className={styles.successBlock}>
          <CheckCircle2 size={14} /> Generated {' '}
          {run.completed_at && <span className={styles.muted}>{formatRelativeTime(run.completed_at)}</span>}
          {typeof run.prs_total === 'number' && run.prs_total > 0 && (
            <span className={styles.muted}> · {run.prs_total} PRs analyzed</span>
          )}
        </div>
      )}

      <div className={styles.actions}>
        {(isFailed || isCompleted) && (
          <button
            className="btn btn-primary btn-sm"
            onClick={onGenerate}
            disabled={starting}
          >
            <RefreshCw size={14} /> {starting ? 'Starting…' : isFailed ? retryLabel : 'Regenerate'}
          </button>
        )}
      </div>

      {startError && <div className={styles.errorBlock}>{startError}</div>}

      {(isCompleted || files['PRODUCT.md']?.exists || files['ARCHITECTURE.md']?.exists) && (
        <FileLinksRow files={files} onViewFile={onViewFile} />
      )}
    </div>
  );
}

function PhaseBadge({ status, phase }) {
  if (status === 'completed') {
    return <span className={`${styles.badge} ${styles.badgeDone}`}><CheckCircle2 size={12} /> Done</span>;
  }
  if (status === 'failed') {
    return <span className={`${styles.badge} ${styles.badgeFailed}`}><AlertTriangle size={12} /> Failed</span>;
  }
  return (
    <span className={`${styles.badge} ${styles.badgeRunning}`}>
      <Loader2 size={12} className={styles.spin} />
      {PHASE_LABEL[phase] || phase}
    </span>
  );
}

function PhaseProgress({ run }) {
  if (run.status === 'completed' || run.status === 'failed') return null;
  const { phase, prs_total, prs_extracted, batches_total, batches_done } = run;
  let detail = '';
  if (phase === 'extracting') {
    detail = prs_total ? `${prs_extracted || 0} of ${prs_total} PRs analyzed` : 'preparing…';
  } else if (phase === 'rolling_up') {
    detail = batches_total ? `Batch ${batches_done || 0} of ${batches_total}` : 'preparing…';
  } else if (phase === 'finalizing') {
    detail = 'Writing files to disk…';
  } else if (phase === 'fetching') {
    detail = 'Listing PRs from GitHub…';
  }
  return <span className={styles.muted}>{detail}</span>;
}

function FileLinksRow({ files, onViewFile }) {
  return (
    <div className={styles.fileLinks}>
      {['PRODUCT.md', 'ARCHITECTURE.md'].map(name => {
        const meta = files[name];
        if (!meta?.exists) {
          return (
            <span key={name} className={styles.fileLinkMissing}>
              <FileText size={12} /> {name} <span className={styles.muted}>(not yet generated)</span>
            </span>
          );
        }
        return (
          <button
            key={name}
            type="button"
            className={styles.fileLinkBtn}
            onClick={() => onViewFile(name)}
          >
            <FileText size={12} /> View {name}
            {meta.modified_at && <span className={styles.muted}> · {formatRelativeTime(meta.modified_at)}</span>}
          </button>
        );
      })}
    </div>
  );
}

function FilePreview({ name, loading, content, onClose }) {
  return (
    <div className={styles.preview}>
      <div className={styles.previewHeader}>
        <strong><FileText size={12} /> {name}</strong>
        <button type="button" className={styles.previewClose} onClick={onClose} title="Close preview">
          <X size={14} />
        </button>
      </div>
      {loading ? (
        <div className={styles.muted}>Loading…</div>
      ) : (
        <pre className={styles.previewPre}>{content}</pre>
      )}
    </div>
  );
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleString();
}
