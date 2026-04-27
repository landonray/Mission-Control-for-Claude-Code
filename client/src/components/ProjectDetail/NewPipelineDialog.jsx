import { useState, useRef } from 'react';
import { api } from '../../utils/api';
import styles from './NewPipelineDialog.module.css';

function isFileAccepted(file) {
  if (file.type.startsWith('text/')) return true;
  const ext = file.name.split('.').pop().toLowerCase();
  return ['md', 'txt', 'markdown'].includes(ext);
}

export default function NewPipelineDialog({ projectId, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [specInput, setSpecInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [attachedFile, setAttachedFile] = useState(null);
  const [attachError, setAttachError] = useState(null);
  const fileInputRef = useRef(null);

  const canSubmit = name.trim() && specInput.trim() && !submitting;

  function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    setAttachError(null);
    if (file.size > 524288) {
      setAttachError('This file is too large to attach directly. Copy and paste the content instead.');
      return;
    }
    if (!isFileAccepted(file)) {
      setAttachError('Only plain text or markdown files can be attached. Copy and paste content from Word or PDF files.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      setSpecInput(event.target.result);
      setAttachedFile(file.name);
    };
    reader.readAsText(file);
  }

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
          <div className={styles.fileAttach}>
            <input
              type="file"
              accept=".md,.txt,.markdown,text/*"
              ref={fileInputRef}
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              className={styles.attachButton}
              onClick={() => fileInputRef.current.click()}
            >
              Attach a file
            </button>
            {attachedFile && (
              <div className={styles.attachmentIndicator}>
                <span>📎 {attachedFile} attached</span>
                <button
                  type="button"
                  className={styles.clearAttach}
                  onClick={() => setAttachedFile(null)}
                  aria-label="Remove attachment"
                >
                  ×
                </button>
              </div>
            )}
            {attachError && (
              <div className={styles.attachError}>{attachError}</div>
            )}
          </div>
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
