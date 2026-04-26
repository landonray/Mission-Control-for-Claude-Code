import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../utils/api';
import { AlertTriangle, FileText, Check, X } from 'lucide-react';
import styles from './DecisionsNeeded.module.css';

export default function DecisionsNeeded({ projectId, onChange }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const data = await api.get(`/api/planning/escalations?project_id=${projectId}`);
      setItems(data || []);
      if (onChange) onChange(data?.length || 0);
    } catch {
      // best effort
    } finally {
      setLoading(false);
    }
  }, [projectId, onChange]);

  useEffect(() => { reload(); }, [reload]);

  if (loading) {
    return <div className={styles.empty}>Loading…</div>;
  }
  if (items.length === 0) {
    return (
      <div className={styles.empty}>
        No decisions waiting for you. When the planning agent escalates a question,
        it will appear here for you to answer.
      </div>
    );
  }

  return (
    <ul className={styles.list}>
      {items.map((item) => (
        <DecisionItem key={item.id} item={item} onResolved={reload} />
      ))}
    </ul>
  );
}

function DecisionItem({ item, onResolved }) {
  const [answer, setAnswer] = useState('');
  const [addToDoc, setAddToDoc] = useState('neither');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async () => {
    if (!answer.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/planning/escalations/${item.id}/answer`, {
        answer: answer.trim(),
        addToContextDoc: addToDoc,
      });
      await onResolved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDismiss = async () => {
    if (!window.confirm('Dismiss this question? The asking Claude session will see "dismissed" instead of an answer.')) return;
    setSubmitting(true);
    try {
      await api.post(`/api/planning/escalations/${item.id}/dismiss`);
      await onResolved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <li className={styles.item}>
      <div className={styles.head}>
        <AlertTriangle size={14} />
        <span className={styles.askedBy}>
          Asked by session <code>{(item.asking_session_id || 'unknown').slice(0, 8)}</code>
        </span>
        <span className={styles.askedAt}>
          {new Date(item.asked_at).toLocaleString()}
        </span>
      </div>

      <div className={styles.questionBlock}>{item.question}</div>

      {item.escalation_context && (
        <details className={styles.details}>
          <summary>Context the planning agent had</summary>
          <div>{item.escalation_context}</div>
        </details>
      )}

      <div className={styles.recBlock}>
        <div className={styles.recLabel}>Planning agent's recommendation:</div>
        <div className={styles.recBody}>{item.escalation_recommendation}</div>
        {item.escalation_reason && (
          <div className={styles.reason}>
            <strong>Why escalated:</strong> {item.escalation_reason}
          </div>
        )}
      </div>

      {item.working_files && item.working_files.length > 0 && (
        <div className={styles.workingFiles}>
          <FileText size={12} /> {item.working_files.join(', ')}
        </div>
      )}

      <label className={styles.field}>
        <span>Your answer</span>
        <textarea
          rows={3}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Type your decision. The planning agent's recommendation is just a starting point."
          disabled={submitting}
        />
      </label>

      <label className={styles.field}>
        <span>Add to</span>
        <select value={addToDoc} onChange={(e) => setAddToDoc(e.target.value)} disabled={submitting}>
          <option value="neither">Neither (just decisions.md)</option>
          <option value="PRODUCT.md">PRODUCT.md</option>
          <option value="ARCHITECTURE.md">ARCHITECTURE.md</option>
        </select>
      </label>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.actions}>
        <button
          className="btn btn-primary btn-sm"
          onClick={handleSubmit}
          disabled={submitting || !answer.trim()}
        >
          <Check size={14} /> {submitting ? 'Submitting…' : 'Submit answer'}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={handleDismiss}
          disabled={submitting}
        >
          <X size={14} /> Dismiss
        </button>
      </div>
    </li>
  );
}
