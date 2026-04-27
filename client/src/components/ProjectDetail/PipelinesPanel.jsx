import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../utils/api';
import NewPipelineDialog from './NewPipelineDialog';
import styles from './PipelinesPanel.module.css';

const STATUS_LABELS = {
  draft: 'Draft',
  running: 'Running',
  paused_for_approval: 'Awaiting approval',
  paused_for_escalation: 'Awaiting decision',
  paused_for_failure: 'Failed — needs attention',
  completed: 'Completed',
  failed: 'Failed',
};

const STAGE_LABELS = {
  1: 'Spec Refinement',
  2: 'QA Design',
  3: 'Implementation Planning',
  4: 'Implementation',
  5: 'QA Execution',
  6: 'Code Review',
  7: 'Fix Cycle',
};

export default function PipelinesPanel({ projectId }) {
  const [pipelines, setPipelines] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get(`/api/pipelines?project_id=${projectId}`);
      setPipelines(res.pipelines || []);
    } catch (err) {
      setError(err.message);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (pipelines === null && !error) {
    return <div className={styles.panel}>Loading pipelines…</div>;
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h3>Pipelines</h3>
        <button className={styles.newButton} onClick={() => setShowDialog(true)}>
          + New Pipeline
        </button>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {pipelines && pipelines.length === 0 && (
        <p className={styles.empty}>No pipelines yet. Create one to start.</p>
      )}
      {pipelines && pipelines.length > 0 && (
        <ul className={styles.list}>
          {pipelines.map((p) => (
            <li key={p.id} className={styles.row}>
              <Link to={`/pipelines/${p.id}`} className={styles.name}>
                {p.name}
              </Link>
              <span className={`${styles.status} ${styles[`status_${p.status}`] || ''}`}>
                {STATUS_LABELS[p.status] || p.status}
              </span>
              <span className={styles.stage}>
                Stage {p.current_stage || 0} / 7
                {p.current_stage > 0 && STAGE_LABELS[p.current_stage]
                  ? ` · ${STAGE_LABELS[p.current_stage]}`
                  : ''}
              </span>
              <span className={styles.created}>{new Date(p.created_at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
      {showDialog && (
        <NewPipelineDialog
          projectId={projectId}
          onClose={() => setShowDialog(false)}
          onCreated={() => { setShowDialog(false); refresh(); }}
        />
      )}
    </div>
  );
}
