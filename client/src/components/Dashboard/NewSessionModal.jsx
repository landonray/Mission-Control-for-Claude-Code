import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import { X, Globe, Clock, Plane, Server, Folder } from 'lucide-react';
import styles from './NewSessionModal.module.css';

const presetIcons = {
  globe: Globe,
  clock: Clock,
  plane: Plane,
  server: Server,
  folder: Folder,
};

export default function NewSessionModal({ onClose }) {
  const { presets, loadSessions } = useApp();
  const navigate = useNavigate();
  const [mode, setMode] = useState('preset'); // 'preset' or 'custom'
  const [form, setForm] = useState({
    name: '',
    workingDirectory: '',
    initialPrompt: '',
    permissionMode: 'default',
    autoAccept: false,
    planMode: false,
  });
  const [loading, setLoading] = useState(false);

  const handlePresetStart = async (presetId) => {
    setLoading(true);
    try {
      const session = await api.post('/api/sessions', { presetId });
      await loadSessions();
      navigate(`/session/${session.id}`);
      onClose();
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
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
        autoAccept: form.autoAccept,
        planMode: form.planMode,
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

        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${mode === 'preset' ? styles.activeTab : ''}`}
            onClick={() => setMode('preset')}
          >
            Presets
          </button>
          <button
            className={`${styles.tab} ${mode === 'custom' ? styles.activeTab : ''}`}
            onClick={() => setMode('custom')}
          >
            Custom
          </button>
        </div>

        {mode === 'preset' && (
          <div className={styles.presetGrid}>
            {presets.map(preset => {
              const Icon = presetIcons[preset.icon] || Folder;
              return (
                <button
                  key={preset.id}
                  className={styles.presetCard}
                  onClick={() => handlePresetStart(preset.id)}
                  disabled={loading}
                >
                  <Icon size={24} />
                  <span className={styles.presetName}>{preset.name}</span>
                  <span className={styles.presetDesc}>{preset.description}</span>
                </button>
              );
            })}
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
              <input
                className="input"
                placeholder="~/projects/my-project"
                value={form.workingDirectory}
                onChange={e => setForm(f => ({ ...f, workingDirectory: e.target.value }))}
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
              <select
                className="input"
                value={form.permissionMode}
                onChange={e => setForm(f => ({ ...f, permissionMode: e.target.value }))}
              >
                <option value="default">Default</option>
                <option value="plan">Plan Mode</option>
                <option value="auto-accept">Auto Accept</option>
              </select>
            </div>

            <div className={styles.toggleRow}>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={form.autoAccept}
                  onChange={e => setForm(f => ({ ...f, autoAccept: e.target.checked }))}
                />
                <span className="toggle-slider" />
              </label>
              <span>Auto-accept mode</span>
            </div>

            <div className={styles.toggleRow}>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={form.planMode}
                  onChange={e => setForm(f => ({ ...f, planMode: e.target.checked }))}
                />
                <span className="toggle-slider" />
              </label>
              <span>Plan mode</span>
            </div>

            <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Starting...' : 'Start Session'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
