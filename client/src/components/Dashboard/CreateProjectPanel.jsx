import React, { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import styles from './CreateProjectPanel.module.css';

const CREATE_STATUS = [
  'Creating folder…',
  'Initializing git…',
  'Creating GitHub repo…',
  'Fetching setup instructions…',
  'Starting session…',
];

const CLONE_STATUS = [
  'Cloning repo from GitHub…',
  'Adding Mission Control config…',
  'Starting session…',
];

export default function CreateProjectPanel({ onBack, onCreated, model }) {
  const { generalSettings } = useApp();
  const [mode, setMode] = useState('create'); // 'create' | 'clone'
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [visibility, setVisibility] = useState('private');
  const [autoSetup, setAutoSetup] = useState(true);
  const [cloneAutoSetup, setCloneAutoSetup] = useState(true);
  const [loading, setLoading] = useState(false);
  const [statusIdx, setStatusIdx] = useState(0);
  const [error, setError] = useState('');

  const hasSetupRepo = !!generalSettings?.setup_repo;

  const normalizeName = (raw) => raw.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').replace(/^-+|-+$/g, '');

  const runWithStatus = async (statusMessages, timeoutMs, apiCall) => {
    setError('');
    setLoading(true);
    setStatusIdx(0);

    const interval = setInterval(() => {
      setStatusIdx(i => Math.min(i + 1, statusMessages.length - 1));
    }, 3000);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      setLoading(false);
      setError('Request timed out. Check that the GitHub CLI is authenticated and try again.');
    }, timeoutMs);

    try {
      const { sessionId } = await apiCall();
      clearTimeout(timeout);
      clearInterval(interval);
      onCreated(sessionId);
    } catch (err) {
      clearTimeout(timeout);
      clearInterval(interval);
      setError(err.message || 'Request failed.');
      setLoading(false);
    }
  };

  const handleCreateSubmit = async (e) => {
    e.preventDefault();
    const normalized = normalizeName(name);
    if (!normalized) {
      setError('Project name is required.');
      return;
    }
    await runWithStatus(CREATE_STATUS, 60000, () => api.post('/api/projects/create', {
      name: normalized,
      visibility,
      model,
      autoSetup: hasSetupRepo && autoSetup,
    }));
  };

  const handleCloneSubmit = async (e) => {
    e.preventDefault();
    if (!repoUrl.trim()) {
      setError('GitHub URL is required.');
      return;
    }
    await runWithStatus(CLONE_STATUS, 120000, () => api.post('/api/projects/clone', {
      url: repoUrl.trim(),
      model,
      autoSetup: cloneAutoSetup,
    }));
  };

  const statusMessages = mode === 'clone' ? CLONE_STATUS : CREATE_STATUS;

  return (
    <div className={styles.panel}>
      <button className="btn btn-ghost btn-sm" onClick={onBack} disabled={loading}>
        <ArrowLeft size={14} /> Back
      </button>

      <h3>Add Project</h3>

      <div className={styles.toggleGroup}>
        <button
          type="button"
          className={`${styles.toggleBtn} ${mode === 'create' ? styles.active : ''}`}
          onClick={() => { setMode('create'); setError(''); }}
          disabled={loading}
        >
          Create New
        </button>
        <button
          type="button"
          className={`${styles.toggleBtn} ${mode === 'clone' ? styles.active : ''}`}
          onClick={() => { setMode('clone'); setError(''); }}
          disabled={loading}
        >
          Clone from GitHub
        </button>
      </div>

      {mode === 'create' && (
        <form onSubmit={handleCreateSubmit} className={styles.form}>
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

          {hasSetupRepo && (
            <div className={styles.field}>
              <label className={styles.toggleLabel}>
                <input
                  type="checkbox"
                  checked={autoSetup}
                  onChange={e => setAutoSetup(e.target.checked)}
                  disabled={loading}
                />
                <span>Auto-setup from repo</span>
              </label>
              <p className={styles.hint}>
                Follow instructions from your setup repo ({generalSettings.setup_repo}) to configure the project automatically.
              </p>
            </div>
          )}

          {error && <p className={styles.error}>{error}</p>}

          <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%' }}>
            {loading ? statusMessages[statusIdx] : 'Create Project'}
          </button>
        </form>
      )}

      {mode === 'clone' && (
        <form onSubmit={handleCloneSubmit} className={styles.form}>
          <div className={styles.field}>
            <label>GitHub URL</label>
            <p className={styles.hint}>Paste a GitHub repo URL, SSH remote, or owner/repo shorthand.</p>
            <input
              className="input"
              placeholder="https://github.com/owner/repo"
              value={repoUrl}
              onChange={e => setRepoUrl(e.target.value)}
              disabled={loading}
              autoFocus
            />
          </div>

          <div className={styles.field}>
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={cloneAutoSetup}
                onChange={e => setCloneAutoSetup(e.target.checked)}
                disabled={loading}
              />
              <span>Auto-setup after clone</span>
            </label>
            <p className={styles.hint}>
              Start a Claude session that reads the README and runs setup steps (install deps, copy env files, etc.).
            </p>
          </div>

          {error && <p className={styles.error}>{error}</p>}

          <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%' }}>
            {loading ? statusMessages[statusIdx] : 'Clone Project'}
          </button>
        </form>
      )}
    </div>
  );
}
