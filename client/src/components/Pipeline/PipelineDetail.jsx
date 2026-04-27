import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../../utils/api';
import StageCard from './StageCard';
import StagePromptEditor from './StagePromptEditor';
import styles from './PipelineDetail.module.css';

const STAGE_NAMES = {
  1: 'Spec Refinement',
  2: 'QA Design',
  3: 'Implementation Planning',
  4: 'Implementation',
  5: 'QA Execution',
  6: 'Code Review',
  7: 'Fix Cycle',
};

function describeState(pipeline) {
  const stage = pipeline.current_stage;
  const stageName = STAGE_NAMES[stage] || `Stage ${stage}`;
  switch (pipeline.status) {
    case 'completed':
      if (pipeline.pr_url) {
        return { tone: 'success', label: 'Completed — pull request opened' };
      }
      if (pipeline.pr_creation_error) {
        return { tone: 'warn', label: 'Completed — but PR creation failed' };
      }
      return { tone: 'success', label: 'Completed — no pull request yet' };
    case 'running':
      return { tone: 'info', label: `Running — Stage ${stage} of 7: ${stageName}` };
    case 'paused_for_approval':
      return { tone: 'info', label: `Awaiting your approval — Stage ${stage} of 7: ${stageName}` };
    case 'paused_for_failure':
      return { tone: 'error', label: `Failed at Stage ${stage} of 7: ${stageName}` };
    case 'paused_for_escalation':
      return { tone: 'warn', label: `Needs your attention — Stage ${stage} of 7: ${stageName}` };
    case 'failed':
      return { tone: 'error', label: 'Failed' };
    case 'draft':
      return { tone: 'muted', label: 'Draft — not yet started' };
    default:
      return { tone: 'muted', label: pipeline.status };
  }
}

export default function PipelineDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [showPrompts, setShowPrompts] = useState(false);
  const [creatingPr, setCreatingPr] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get(`/api/pipelines/${id}`);
      setData(res);
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe_pipeline', pipelineId: id }));
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pipeline_status_changed' && msg.pipelineId === id) {
            refresh();
          }
        } catch (_) { /* ignore */ }
      };
    } catch (_) { /* ignore (e.g. in tests with no WS) */ }
    return () => { try { ws && ws.close(); } catch (_) {} };
  }, [id, refresh]);

  async function handleApprove() {
    setActionError(null);
    try {
      await api.post(`/api/pipelines/${id}/approve`);
      await refresh();
    } catch (err) { setActionError(err.message); }
  }

  async function handleReject(feedback) {
    setActionError(null);
    try {
      await api.post(`/api/pipelines/${id}/reject`, { feedback });
      await refresh();
    } catch (err) { setActionError(err.message); }
  }

  async function handlePromptUpdate(stage, prompt) {
    await api.put(`/api/pipelines/${id}/prompts/${stage}`, { prompt });
    await refresh();
  }

  async function handleCreatePr() {
    setActionError(null);
    setCreatingPr(true);
    try {
      const res = await api.post(`/api/pipelines/${id}/create-pr`);
      if (res && res.url) window.open(res.url, '_blank', 'noopener,noreferrer');
      await refresh();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setCreatingPr(false);
    }
  }

  if (error) return <div className={styles.error}>{error}</div>;
  if (!data) return <div className={styles.loading}>Loading…</div>;

  const { pipeline, outputs, prompts, sessions, chunks = [], escalations = [], github_repo } = data;
  const sessionsByStage = (stage) => sessions.filter((s) => s.pipeline_stage === stage);
  const outputForStage = (stage) =>
    outputs.filter((o) => o.stage === stage).sort((a, b) => b.iteration - a.iteration)[0] || null;

  const state = describeState(pipeline);
  const isCompleted = pipeline.status === 'completed';
  const branchUrl = github_repo ? `https://github.com/${github_repo}/tree/${pipeline.branch_name}` : null;
  const diffUrl = github_repo ? `https://github.com/${github_repo}/compare/main...${pipeline.branch_name}` : null;
  const startedAt = pipeline.created_at ? new Date(pipeline.created_at).toLocaleString() : null;
  const completedAt = pipeline.completed_at ? new Date(pipeline.completed_at).toLocaleString() : null;
  const fixCycleCount = pipeline.fix_cycle_count || 0;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.headerMain}>
          <Link to={`/projects/${pipeline.project_id}`} className={styles.back}>← Back to project</Link>
          <h2>{pipeline.name}</h2>
          <span className={`${styles.statePill} ${styles[`tone_${state.tone}`]}`}>
            {state.label}
          </span>
        </div>
        <button onClick={() => setShowPrompts((s) => !s)}>
          {showPrompts ? 'Hide' : 'Edit'} stage prompts
        </button>
      </div>

      {actionError && <div className={styles.error}>{actionError}</div>}

      <div className={styles.summaryPanel}>
        <h4 className={styles.summaryTitle}>What happened</h4>
        <dl className={styles.summaryGrid}>
          <dt>Branch</dt>
          <dd>
            <code>{pipeline.branch_name}</code>
            {branchUrl && (
              <span className={styles.summaryLinks}>
                <a href={branchUrl} target="_blank" rel="noopener noreferrer" className={styles.summaryLink}>
                  View branch on GitHub →
                </a>
                <a href={diffUrl} target="_blank" rel="noopener noreferrer" className={styles.summaryLink}>
                  View diff →
                </a>
              </span>
            )}
          </dd>

          <dt>Pull request</dt>
          <dd>
            {pipeline.pr_url ? (
              <div className={styles.prRow}>
                <a
                  href={pipeline.pr_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.prLink}
                >
                  View pull request →
                </a>
                <span className={styles.prUrl}>{pipeline.pr_url}</span>
              </div>
            ) : isCompleted ? (
              <div className={styles.prMissing}>
                {pipeline.pr_creation_error ? (
                  <div className={styles.prError}>
                    PR couldn&apos;t be created: {pipeline.pr_creation_error}
                  </div>
                ) : (
                  <div className={styles.muted}>No pull request has been created yet.</div>
                )}
                <button
                  onClick={handleCreatePr}
                  disabled={creatingPr}
                  className={styles.createPrButton}
                >
                  {creatingPr
                    ? 'Creating PR…'
                    : pipeline.pr_creation_error
                      ? 'Retry pull request creation'
                      : 'Create pull request'}
                </button>
              </div>
            ) : (
              <span className={styles.muted}>Not yet — pipeline still running.</span>
            )}
          </dd>

          <dt>Progress</dt>
          <dd>
            {isCompleted
              ? 'All 7 stages completed.'
              : `Stage ${pipeline.current_stage} of 7 — ${STAGE_NAMES[pipeline.current_stage] || ''}`}
            {(outputs.length > 0 || chunks.length > 0) && (
              <span className={styles.muted}>
                {outputs.length > 0 && ` · ${outputs.length} stage outputs`}
                {chunks.length > 0 && ` · ${chunks.length} build chunks`}
              </span>
            )}
          </dd>

          {fixCycleCount > 0 && (
            <>
              <dt>Fix cycles</dt>
              <dd>
                {fixCycleCount} of 3 used{isCompleted ? ' to pass QA' : ''}
              </dd>
            </>
          )}

          {(startedAt || completedAt) && (
            <>
              <dt>Timing</dt>
              <dd>
                {startedAt && <>Started {startedAt}</>}
                {completedAt && <> · Completed {completedAt}</>}
              </dd>
            </>
          )}
        </dl>
      </div>

      {escalations.length > 0 && (
        <div className={styles.escalationBanner}>
          <h4>Pipeline needs your attention</h4>
          {escalations.map((esc) => (
            <div key={esc.id} className={styles.escalation}>
              <div><strong>Stage {esc.stage}:</strong> {esc.summary}</div>
              {esc.detail && <pre className={styles.escalationDetail}>{esc.detail}</pre>}
            </div>
          ))}
        </div>
      )}

      {showPrompts && (
        <StagePromptEditor prompts={prompts} onSave={handlePromptUpdate} />
      )}

      <div className={styles.stages}>
        {[1, 2, 3, 4, 5, 6, 7].map((stage) => (
          <StageCard
            key={stage}
            pipeline={pipeline}
            stage={stage}
            output={outputForStage(stage)}
            sessions={sessionsByStage(stage)}
            chunks={stage === 4 ? chunks : []}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        ))}
      </div>
    </div>
  );
}
