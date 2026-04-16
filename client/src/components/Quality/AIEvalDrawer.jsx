import { useState, useEffect, useRef } from 'react';
import { ChevronLeft, Sparkles, Loader, AlertCircle } from 'lucide-react';
import { api } from '../../utils/api';
import styles from './AIEvalDrawer.module.css';

const PROGRESS_STEPS = [
  { delay: 0, message: 'Investigating your project...' },
  { delay: 8000, message: 'Reviewing existing evals...' },
  { delay: 16000, message: 'Drafting eval...' },
  { delay: 30000, message: 'Finalizing...' },
];

export default function AIEvalDrawer({
  folderPath,
  folderName,
  projectId,
  onComplete,
  onCancel,
  onBuildManually,
  originalDescription = '',
  refinementMode = false,
  currentFormState = null,
}) {
  const [description, setDescription] = useState(originalDescription);
  const [refinement, setRefinement] = useState('');
  const [status, setStatus] = useState('input');
  const [progressMessage, setProgressMessage] = useState('');
  const [error, setError] = useState(null);
  const [jobId, setJobId] = useState(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (status === 'input' && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [status]);

  // Client-side timer for progress messages
  useEffect(() => {
    if (status !== 'working') return;
    const timers = PROGRESS_STEPS.map(({ delay, message }) =>
      setTimeout(() => setProgressMessage(message), delay)
    );
    return () => timers.forEach(clearTimeout);
  }, [status]);

  // WebSocket connection for job updates
  useEffect(() => {
    if (!jobId) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.jobId !== jobId) return;
      if (msg.type === 'eval_authoring_progress') {
        setProgressMessage(msg.message);
      } else if (msg.type === 'eval_authoring_complete') {
        onComplete(msg.eval, msg.reasoning);
      } else if (msg.type === 'eval_authoring_error') {
        setError(msg.message || 'Something went wrong. Please try again.');
        setStatus('error');
      }
    };
    return () => ws.close();
  }, [jobId, onComplete]);

  const handleSubmit = async () => {
    if (!description.trim()) return;
    setStatus('working');
    setError(null);
    try {
      const body = { description, folderPath };
      if (refinementMode && refinement.trim()) body.refinement = refinement;
      if (refinementMode && currentFormState) body.currentFormState = currentFormState;
      const result = await api.post(`/api/evals/folders/${projectId}/author`, body);
      setJobId(result.jobId);
    } catch (err) {
      setError(err.message || 'Failed to start authoring. Please try again.');
      setStatus('error');
    }
  };

  const handleTryAgain = () => {
    setError(null);
    setJobId(null);
    setStatus('input');
  };

  if (status === 'working') {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <Loader size={14} className={styles.spinner} />
          Building eval...
        </div>
        <div className={styles.progressArea}>
          <Loader size={28} className={styles.spinner} />
          {progressMessage && (
            <p className={styles.progressMessage}>{progressMessage}</p>
          )}
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <AlertCircle size={14} />
          Authoring failed
        </div>
        <div className={styles.errorArea}>
          <p className={styles.errorMessage}>{error}</p>
          <div className={styles.actions}>
            <button className={styles.retryButton} onClick={handleTryAgain} type="button">
              Try Again
            </button>
            <button className={styles.manualLink} onClick={onBuildManually} type="button">
              Build manually
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <button className={styles.backButton} onClick={onCancel} type="button">
        <ChevronLeft size={14} />
        {refinementMode ? 'Back to form' : 'Back'}
      </button>
      <div className={styles.header}>
        <Sparkles size={14} />
        {refinementMode ? 'Refine Eval' : 'Build Eval with AI'}
      </div>
      {folderName && (
        <p className={styles.folderLabel}>Folder: {folderName}</p>
      )}
      <div className={styles.inputArea}>
        <label className={styles.label}>
          {refinementMode ? 'Original description' : 'What should this eval check?'}
        </label>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          rows={5}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Check that recipe extraction pulls out all ingredients, quantities, and steps accurately from unstructured text"
          autoFocus
        />
      </div>
      {refinementMode && (
        <div className={styles.inputArea}>
          <label className={styles.label}>What would you like to change?</label>
          <textarea
            className={styles.textarea}
            rows={3}
            value={refinement}
            onChange={(e) => setRefinement(e.target.value)}
            placeholder="e.g. Add a test case for recipes with missing quantities"
          />
        </div>
      )}
      <div className={styles.actions}>
        <button className={styles.cancelButton} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className={styles.submitButton}
          onClick={handleSubmit}
          type="button"
          disabled={!description.trim()}
        >
          {refinementMode ? 'Refine' : 'Build with AI'}
        </button>
      </div>
    </div>
  );
}
