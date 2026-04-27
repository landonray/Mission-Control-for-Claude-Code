import { useState } from 'react';
import { api } from '../../utils/api';
import styles from './NewPipelineDialog.module.css';

export default function NewPipelineDialog({ projectId, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [specInput, setSpecInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const canSubmit = name.trim() && specInput.trim() && !submitting;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.post('/api/pipelines', {
        project_id: projectId,
        name: name.trim(),
        spec_input: specInput,
      });
      onCreated(result);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3>New Pipeline</h3>
        <form onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span>Pipeline name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Add pagination support"
              autoFocus
            />
          </label>
          <label className={styles.field}>
            <span>Spec</span>
            <textarea
              value={specInput}
              onChange={(e) => setSpecInput(e.target.value)}
              placeholder="Paste or write the raw spec — what you want built, what it should do, any constraints."
              rows={12}
            />
          </label>
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.actions}>
            <button type="button" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" disabled={!canSubmit}>
              {submitting ? 'Starting…' : 'Start Pipeline'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
