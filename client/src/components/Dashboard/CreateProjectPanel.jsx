import React, { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { api } from '../../utils/api';
import styles from './CreateProjectPanel.module.css';

const STATUS_MESSAGES = [
  'Creating folder…',
  'Initializing git…',
  'Creating GitHub repo…',
  'Starting session…',
];

export default function CreateProjectPanel({ onBack, onCreated }) {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState('private');
  const [loading, setLoading] = useState(false);
  const [statusIdx, setStatusIdx] = useState(0);
  const [error, setError] = useState('');

  const normalizeName = (raw) => raw.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '');

  const handleSubmit = async (e) => {
    e.preventDefault();
    const normalized = normalizeName(name);
    if (!normalized) {
      setError('Project name is required.');
      return;
    }
    setError('');
    setLoading(true);
    setStatusIdx(0);

    const interval = setInterval(() => {
      setStatusIdx(i => Math.min(i + 1, STATUS_MESSAGES.length - 1));
    }, 3000);

    const timeout = setTimeout(() => {
      clearInterval(interval);
      setLoading(false);
      setError('Request timed out. Check that the GitHub CLI is authenticated and try again.');
    }, 60000);

    try {
      const { sessionId } = await api.post('/api/projects/create', {
        name: normalized,
        visibility,
      });
      clearTimeout(timeout);
      clearInterval(interval);
      onCreated(sessionId);
    } catch (err) {
      clearTimeout(timeout);
      clearInterval(interval);
      setError(err.message || 'Failed to create project.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.panel}>
      <button className="btn btn-ghost btn-sm" onClick={onBack} disabled={loading}>
        <ArrowLeft size={14} /> Back
      </button>

      <h3>Create New Project</h3>

      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.field}>
          <label>Project Name</label>
          <p className={styles.hint}>Alphanumeric, hyphens, underscores. Spaces become hyphens.</p>
          <input
            className="input"
            placeholder="my-new-project"
            value={name}
            onChange={e => setName(e.target.value)}
            disabled={loading}
            maxLength={100}
            autoFocus
          />
          {name && normalizeName(name) !== name && (
            <p className={styles.preview}>Will be created as: <strong>{normalizeName(name)}</strong></p>
          )}
        </div>

        <div className={styles.field}>
          <label>Visibility</label>
          <div className={styles.toggleGroup}>
            <button
              type="button"
              className={`${styles.toggleBtn} ${visibility === 'private' ? styles.active : ''}`}
              onClick={() => setVisibility('private')}
              disabled={loading}
            >
              Private
            </button>
            <button
              type="button"
              className={`${styles.toggleBtn} ${visibility === 'public' ? styles.active : ''}`}
              onClick={() => setVisibility('public')}
              disabled={loading}
            >
              Public
            </button>
          </div>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%' }}>
          {loading ? STATUS_MESSAGES[statusIdx] : 'Create Project'}
        </button>
      </form>
    </div>
  );
}
