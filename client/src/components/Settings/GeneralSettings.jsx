import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import FolderPicker from '../shared/FolderPicker';
import styles from './GeneralSettings.module.css';

export default function GeneralSettings() {
  const { generalSettings, loadGeneralSettings } = useApp();
  const [form, setForm] = useState({ projects_directory: '', github_username: '', setup_repo: '' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (generalSettings) {
      setForm({
        projects_directory: generalSettings.projects_directory || '',
        github_username: generalSettings.github_username || '',
        setup_repo: generalSettings.setup_repo || '',
      });
    }
  }, [generalSettings]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      await api.put('/api/settings/general', form);
      await loadGeneralSettings();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSave}>
      <h2>General</h2>

      <div className={styles.field}>
        <label>Projects Directory</label>
        <p className={styles.hint}>The local folder containing your projects. Subfolders appear in the New Session modal.</p>
        <FolderPicker
          value={form.projects_directory}
          onChange={v => setForm(f => ({ ...f, projects_directory: v }))}
          placeholder="/Users/you/Coding Projects"
        />
      </div>

      <div className={styles.field}>
        <label>GitHub Username / Org</label>
        <p className={styles.hint}>Used when creating new GitHub repos.</p>
        <input
          className="input"
          placeholder="your-github-username"
          value={form.github_username}
          onChange={e => setForm(f => ({ ...f, github_username: e.target.value }))}
        />
      </div>

      <div className={styles.field}>
        <label>Project Setup Repo</label>
        <p className={styles.hint}>
          A GitHub repo whose README contains setup instructions for new projects (e.g. copy CLAUDE.md, create database, set env vars).
          When creating a new project, Claude will automatically follow these instructions.
        </p>
        <input
          className="input"
          placeholder="owner/repo or https://github.com/owner/repo"
          value={form.setup_repo}
          onChange={e => setForm(f => ({ ...f, setup_repo: e.target.value }))}
        />
      </div>

      <button className="btn btn-primary" type="submit" disabled={saving}>
        {saving ? 'Saving…' : saved ? 'Saved!' : 'Save'}
      </button>

      <div className={styles.restartSection}>
        <h3>Server</h3>
        <p className={styles.hint}>Restart the Command Center server process. Active tmux sessions will survive the restart.</p>
        <button
          className="btn btn-danger"
          type="button"
          disabled={restarting}
          onClick={async () => {
            if (!confirm('Restart the server? The page will briefly disconnect.')) return;
            setRestarting(true);
            try {
              await api.post('/api/settings/restart', { confirm: true });
            } catch {
              // Expected — server shuts down before response sometimes
            }
            // Poll until server is back
            const poll = setInterval(async () => {
              try {
                const resp = await fetch('/api/health');
                if (resp.ok) {
                  clearInterval(poll);
                  window.location.reload();
                }
              } catch {
                // Still down, keep polling
              }
            }, 1500);
          }}
        >
          {restarting ? 'Restarting…' : 'Restart Server'}
        </button>
      </div>
    </form>
  );
}
