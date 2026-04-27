import { useState, useEffect } from 'react';
import { api } from '../../utils/api';
import { colorForSessionType, badgeForSessionType, labelForSessionType } from '../../utils/sessionColors';
import styles from './StageCard.module.css';

const STAGE_NAMES = {
  1: 'Spec Refinement',
  2: 'QA Design',
  3: 'Implementation Planning',
  4: 'Implementation',
  5: 'QA Execution',
  6: 'Code Review',
  7: 'Fix Cycle',
};

const SESSION_TYPE_FOR_STAGE = {
  1: 'spec_refinement',
  2: 'qa_design',
  3: 'implementation_planning',
  4: 'implementation',
  5: 'qa_execution',
  6: 'code_review',
  7: 'implementation',
};

// Stages that produce a doc the user reads inline. Stages 4 and 7 are code-only.
const STAGE_HAS_DOC = { 1: true, 2: true, 3: true, 5: true, 6: true };

// Only stages 1-3 are user-gated. The rest run autonomously.
const STAGE_IS_GATED = { 1: true, 2: true, 3: true };

export default function StageCard({ pipeline, stage, output, sessions, chunks, onApprove, onReject }) {
  const [content, setContent] = useState(null);
  const [contentError, setContentError] = useState(null);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [feedback, setFeedback] = useState('');

  const sessionType = SESSION_TYPE_FOR_STAGE[stage];
  const stageStatus = computeStageStatus(pipeline, stage, output);
  const isCurrent = pipeline.current_stage === stage;
  const isPausedForApproval =
    isCurrent && pipeline.status === 'paused_for_approval' && output && STAGE_IS_GATED[stage];

  useEffect(() => {
    if (!output || !STAGE_HAS_DOC[stage]) { setContent(null); return; }
    let cancelled = false;
    api
      .get(`/api/pipelines/${pipeline.id}/output/${stage}`)
      .then((res) => { if (!cancelled) setContent(res.content); })
      .catch((err) => { if (!cancelled) setContentError(err.message); });
    return () => { cancelled = true; };
  }, [pipeline.id, stage, output && output.iteration]);

  const stageChunks = stage === 4 && Array.isArray(chunks) ? chunks : [];

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
      {stage === 4 && stageChunks.length > 0 && (
        <ul className={styles.chunkList}>
          {stageChunks.map((chunk) => (
            <li key={chunk.chunk_index} className={`${styles.chunkRow} ${styles[`chunk_${chunk.status}`]}`}>
              <strong>Chunk {chunk.chunk_index}:</strong> {chunk.name}
              <span className={styles.chunkStatus}>{chunk.status}</span>
              {chunk.complexity && <span className={styles.chunkMeta}>· {chunk.complexity}</span>}
            </li>
          ))}
        </ul>
      )}
      {stage === 7 && (pipeline.fix_cycle_count || 0) > 0 && (
        <div className={styles.fixCycleMeta}>
          Fix cycle iteration {pipeline.fix_cycle_count} of 3.
        </div>
      )}
      {output && STAGE_HAS_DOC[stage] && (
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
  if (pipeline.status === 'completed' && stage <= pipeline.current_stage) return 'completed';
  if (stage < pipeline.current_stage) return 'completed';
  if (stage > pipeline.current_stage) return 'pending';
  if (pipeline.status === 'paused_for_approval' && output) return 'awaiting_approval';
  if (pipeline.status === 'paused_for_failure') return 'failed';
  if (pipeline.status === 'paused_for_escalation') return 'escalated';
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
    escalated: 'Awaiting decision',
  })[status] || status;
}
