import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import { X, Plus, GitBranch, Cpu } from 'lucide-react';
import PillSelector from '../common/PillSelector';
import ProjectCard from './ProjectCard';
import CreateProjectPanel from './CreateProjectPanel';
import FolderPicker from '../shared/FolderPicker';
import styles from './NewSessionModal.module.css';

export default function NewSessionModal({ onClose }) {
  const { loadSessions, generalSettings } = useApp();
  const navigate = useNavigate();
  const [mode, setMode] = useState('preset');
  const [view, setView] = useState('tabs'); // 'tabs' | 'create'
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [useWorktree, setUseWorktree] = useState(true);
  const [model, setModel] = useState('claude-opus-4-6');
  const [form, setForm] = useState({
    name: '',
    workingDirectory: '',
    initialPrompt: '',
    permissionMode: 'acceptEdits',
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (mode === 'preset') {
      setProjectsLoading(true);
      api.get('/api/projects')
        .then(setProjects)
        .catch(() => setProjects([]))
        .finally(() => setProjectsLoading(false));
    }
  }, [mode]);

  const handleProjectStart = async (project) => {
    setLoading(true);
    try {
      let session;
      if (project.preset) {
        session = await api.post('/api/sessions', { presetId: project.preset.id, useWorktree, model });
      } else {
        session = await api.post('/api/sessions', {
          name: project.name,
          workingDirectory: project.path,
          permissionMode: 'acceptEdits',
          useWorktree,
          model,
        });
      }
      await loadSessions();
      navigate(`/session/${session.id}`);
      onClose();
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreated = async (sessionId) => {
    await loadSessions();
    navigate(`/session/${sessionId}`);
    onClose();
  };

  const handleCustomStart = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const session = await api.post('/api/sessions', {
        name: form.name || undefined,
        workingDirectory: form.workingDirectory || undefined,
        initialPrompt: form.initialPrompt || undefined,
        permissionMode: form.permissionMode,
        useWorktree,
        model,
      });
      await loadSessions();
      navigate(`/session/${session.id}`);
      onClose();
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2>New Session</h2>
          <button className="btn-ghost btn-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {view === 'create' ? (
          <CreateProjectPanel
            onBack={() => setView('tabs')}
            onCreated={handleCreated}
            model={model}
          />
        ) : (
          <>
            <div className={styles.tabs}>
              <button
                className={`${styles.tab} ${mode === 'preset' ? styles.activeTab : ''}`}
                onClick={() => setMode('preset')}
              >
                Projects
              </button>
              <button
                className={`${styles.tab} ${mode === 'custom' ? styles.activeTab : ''}`}
                onClick={() => setMode('custom')}
              >
                Custom
              </button>
            </div>

            <div className={styles.worktreeToggle}>
              <label className={styles.toggleLabel}>
                <GitBranch size={14} />
                <span>Use worktree</span>
              </label>
              <button
                type="button"
                className={`${styles.toggle} ${useWorktree ? styles.toggleOn : ''}`}
                onClick={() => setUseWorktree(v => !v)}
                aria-pressed={useWorktree}
              >
                <span className={styles.toggleKnob} />
              </button>
            </div>

            <div className={styles.modelSelector}>
              <label className={styles.toggleLabel}>
                <Cpu size={14} />
                <span>Model</span>
              </label>
              <PillSelector
                options={[
                  { value: 'claude-opus-4-6', label: 'Opus' },
                  { value: 'claude-sonnet-4-6', label: 'Sonnet' },
                ]}
                value={model}
                onChange={setModel}
              />
            </div>

            {mode === 'preset' && (
              <div className={styles.presetGrid}>
                <button
                  className={`${styles.presetCard} ${styles.createCard}`}
                  onClick={() => setView('create')}
                  disabled={loading}
                >
                  <Plus size={24} />
                  <span className={styles.presetName}>Create New</span>
                  <span className={styles.presetDesc}>New folder + GitHub repo</span>
                </button>

                {projectsLoading && (
                  <div className={styles.emptyState}>Loading projects…</div>
                )}

                {!projectsLoading && projects.length === 0 && !generalSettings?.projects_directory && (
                  <div className={styles.emptyState}>
                    No projects directory configured.{' '}
                    <a href="/settings" onClick={onClose}>Go to Settings → General</a>
                  </div>
                )}

                {projects.map(project => (
                  <ProjectCard
                    key={project.path}
                    project={project}
                    onClick={() => handleProjectStart(project)}
                    disabled={loading}
                  />
                ))}
              </div>
            )}

            {mode === 'custom' && (
              <form className={styles.form} onSubmit={handleCustomStart}>
                <div className={styles.field}>
                  <label>Session Name</label>
                  <input
                    className="input"
                    placeholder="My Session"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  />
                </div>

                <div className={styles.field}>
                  <label>Working Directory</label>
                  <FolderPicker
                    value={form.workingDirectory}
                    onChange={v => setForm(f => ({ ...f, workingDirectory: v }))}
                  />
                </div>

                <div className={styles.field}>
                  <label>Initial Prompt (optional)</label>
                  <textarea
                    className="input"
                    placeholder="What should Claude work on?"
                    value={form.initialPrompt}
                    onChange={e => setForm(f => ({ ...f, initialPrompt: e.target.value }))}
                    rows={3}
                  />
                </div>

                <div className={styles.field}>
                  <label>Permission Mode</label>
                  <PillSelector
                    options={[
                      { value: 'acceptEdits', label: 'Accept Edits' },
                      { value: 'auto', label: 'Auto' },
                      { value: 'plan', label: 'Plan' },
                      { value: 'default', label: 'Ask' },
                    ]}
                    value={form.permissionMode}
                    onChange={v => setForm(f => ({ ...f, permissionMode: v }))}
                  />
                </div>

                <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%' }}>
                  {loading ? 'Starting...' : 'Start Session'}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
