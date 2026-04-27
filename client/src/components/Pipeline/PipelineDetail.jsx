import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../../utils/api';
import StageCard from './StageCard';
import StagePromptEditor from './StagePromptEditor';
import styles from './PipelineDetail.module.css';

export default function PipelineDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [showPrompts, setShowPrompts] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get(`/api/pipelines/${id}`);
      setData(res);
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  // Subscribe to real-time pipeline status changes via WebSocket.
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

  if (error) return <div className={styles.error}>{error}</div>;
  if (!data) return <div className={styles.loading}>Loading…</div>;

  const { pipeline, outputs, prompts, sessions, chunks = [], escalations = [] } = data;
  const sessionsByStage = (stage) => sessions.filter((s) => s.pipeline_stage === stage);
  const outputForStage = (stage) =>
    outputs.filter((o) => o.stage === stage).sort((a, b) => b.iteration - a.iteration)[0] || null;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <Link to={`/projects/${pipeline.project_id}`} className={styles.back}>← Back to project</Link>
          <h2>{pipeline.name}</h2>
          <p className={styles.meta}>
            Branch: <code>{pipeline.branch_name}</code> · Status: <strong>{pipeline.status}</strong>
            {pipeline.fix_cycle_count > 0 && (
              <span> · Fix cycles used: <strong>{pipeline.fix_cycle_count}</strong> / 3</span>
            )}
          </p>
        </div>
        <button onClick={() => setShowPrompts((s) => !s)}>
          {showPrompts ? 'Hide' : 'Edit'} stage prompts
        </button>
      </div>

      {actionError && <div className={styles.error}>{actionError}</div>}

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
