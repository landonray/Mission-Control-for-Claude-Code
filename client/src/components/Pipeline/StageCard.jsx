import { useState, useEffect } from 'react';
import { api } from '../../utils/api';
import { colorForSessionType, badgeForSessionType, labelForSessionType } from '../../utils/sessionColors';
import styles from './StageCard.module.css';

const STAGE_NAMES = {
  1: 'Spec Refinement',
  2: 'QA Design',
  3: 'Implementation Planning',
};

const SESSION_TYPE_FOR_STAGE = {
  1: 'spec_refinement',
  2: 'qa_design',
  3: 'implementation_planning',
};

export default function StageCard({ pipeline, stage, output, sessions, onApprove, onReject }) {
  const [content, setContent] = useState(null);
  const [contentError, setContentError] = useState(null);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [feedback, setFeedback] = useState('');

  const sessionType = SESSION_TYPE_FOR_STAGE[stage];
  const stageStatus = computeStageStatus(pipeline, stage, output);
  const isCurrent = pipeline.current_stage === stage;
  const isPausedForApproval = isCurrent && pipeline.status === 'paused_for_approval' && output;

  useEffect(() => {
    if (!output) { setContent(null); return; }
    let cancelled = false;
    api
      .get(`/api/pipelines/${pipeline.id}/output/${stage}`)
      .then((res) => { if (!cancelled) setContent(res.content); })
      .catch((err) => { if (!cancelled) setContentError(err.message); });
    return () => { cancelled = true; };
  }, [pipeline.id, stage, output && output.iteration]);

  return (
    <div className={`${styles.card} ${isCurrent ? styles.current : ''}`}>
      <div className={styles.header}>
        <span className={`session-badge color-${colorForSessionType(sessionType)}`}>
          {badgeForSessionType(sessionType)}
        </span>
        <h4>Stage {stage}: {STAGE_NAMES[stage]}</h4>
        <span className={`${styles.statusPill} ${styles[`status_${stageStatus}`]}`}>
          {humanizeStageStatus(stageStatus)}
        </span>
      </div>
      <div className={styles.sessions}>
        {sessions.length === 0 ? (
          <span className={styles.noSessions}>No sessions yet</span>
        ) : (
          sessions.map((s) => (
            <span key={s.id} className={styles.session}>
              {labelForSessionType(s.session_type)} — {s.status}
            </span>
          ))
        )}
      </div>
      {output && (
        <div className={styles.output}>
          <div className={styles.outputHeader}>
            Output: <code>{output.output_path}</code>
            {output.iteration > 1 && <span className={styles.iteration}> (iteration {output.iteration})</span>}
          </div>
          {contentError && <div className={styles.error}>{contentError}</div>}
          {content && <pre className={styles.content}>{content}</pre>}
        </div>
      )}
      {isPausedForApproval && (
        <div className={styles.actions}>
          {!showRejectForm ? (
            <>
              <button className={styles.approveBtn} onClick={() => onApprove()}>Approve</button>
              <button className={styles.rejectBtn} onClick={() => setShowRejectForm(true)}>Reject</button>
            </>
          ) : (
            <div className={styles.rejectForm}>
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Why are you rejecting? Be specific so the next attempt can address it."
                rows={4}
              />
              <div>
                <button onClick={() => setShowRejectForm(false)}>Cancel</button>
                <button
                  className={styles.rejectBtn}
                  disabled={!feedback.trim()}
                  onClick={() => onReject(feedback)}
                >
                  Submit Rejection
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function computeStageStatus(pipeline, stage, output) {
  if (pipeline.status === 'completed' || stage < pipeline.current_stage) return 'completed';
  if (stage > pipeline.current_stage) return 'pending';
  if (pipeline.status === 'paused_for_approval' && output) return 'awaiting_approval';
  if (pipeline.status === 'paused_for_failure') return 'failed';
  if (pipeline.status === 'running') return 'in_progress';
  return pipeline.status;
}

function humanizeStageStatus(status) {
  return ({
    completed: 'Completed',
    pending: 'Pending',
    in_progress: 'In progress',
    awaiting_approval: 'Awaiting approval',
    failed: 'Failed',
  })[status] || status;
}
