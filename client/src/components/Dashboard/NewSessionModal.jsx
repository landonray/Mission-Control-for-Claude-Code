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
  const [mode, setMode] = useState('projects');
  const [view, setView] = useState('tabs'); // 'tabs' | 'create'
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [useWorktree, setUseWorktree] = useState(true);
  const [modelOptions, setModelOptions] = useState([]);
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState('auto');
  const [effortOptions, setEffortOptions] = useState([]);
  const [effort, setEffort] = useState('high');
  const [xhighModels, setXhighModels] = useState([]);
  const [effortNote, setEffortNote] = useState(null);
  const [form, setForm] = useState({
    name: '',
    workingDirectory: '',
    initialPrompt: '',
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/api/models').then(data => {
      setModelOptions(data.models || []);
      setModel(data.defaultModel || data.models?.[0]?.value || '');
      setEffortOptions((data.efforts || ['high', 'xhigh', 'max']).map(e => ({
        value: e,
        label: e === 'xhigh' ? 'xHigh' : e.charAt(0).toUpperCase() + e.slice(1),
      })));
      setEffort(data.defaultEffort || 'high');
      setXhighModels(data.xhighSupportedModels || []);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (effort === 'xhigh' && xhighModels.length > 0 && !xhighModels.includes(model)) {
      setEffort('high');
      setEffortNote('Effort lowered to High — xHigh is Opus 4.7 only.');
      const timer = setTimeout(() => setEffortNote(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [model, effort, xhighModels]);

  useEffect(() => {
    if (mode === 'projects') {
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
      const session = await api.post('/api/sessions', {
        name: project.name,
        workingDirectory: project.path,
        permissionMode,
        useWorktree,
        model,
        effort,
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
        permissionMode,
        useWorktree,
        model,
        effort,
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
                className={`${styles.tab} ${mode === 'projects' ? styles.activeTab : ''}`}
                onClick={() => setMode('projects')}
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
                options={modelOptions}
                value={model}
                onChange={setModel}
              />
            </div>

            <div className={styles.modelSelector}>
              <label className={styles.toggleLabel}>
                <Cpu size={14} />
                <span>Effort</span>
              </label>
              <PillSelector
                options={effortOptions.map(opt => ({
                  ...opt,
                  disabled: opt.value === 'xhigh' && xhighModels.length > 0 && !xhighModels.includes(model),
                  title: (opt.value === 'xhigh' && xhighModels.length > 0 && !xhighModels.includes(model))
                    ? 'Opus 4.7 only — other models use high'
                    : undefined,
                }))}
                value={effort}
                onChange={setEffort}
              />
              {effortNote && <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>{effortNote}</div>}
            </div>

            <div className={styles.modelSelector}>
              <label className={styles.toggleLabel}>
                <span>Permissions</span>
              </label>
              <PillSelector
                options={[
                  { value: 'plan', label: 'Plan' },
                  { value: 'default', label: 'Ask' },
                  { value: 'acceptEdits', label: 'Edits' },
                  { value: 'auto', label: 'Auto' },
                  { value: 'bypassPermissions', label: 'YOLO' },
                ]}
                value={permissionMode}
                onChange={setPermissionMode}
              />
            </div>

            {mode === 'projects' && (
              <div className={styles.presetGrid}>
                <button
                  className={`${styles.presetCard} ${styles.createCard}`}
                  onClick={() => setView('create')}
                  disabled={loading}
                >
                  <Plus size={24} />
                  <span className={styles.presetName}>Add Project</span>
                  <span className={styles.presetDesc}>Create new or clone from GitHub</span>
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
