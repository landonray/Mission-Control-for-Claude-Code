import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import FolderPicker from '../shared/FolderPicker';
import styles from './GeneralSettings.module.css';

export default function GeneralSettings() {
  const { generalSettings, loadGeneralSettings } = useApp();
  const [form, setForm] = useState({ projects_directory: '', github_username: '' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (generalSettings) {
      setForm({
        projects_directory: generalSettings.projects_directory || '',
        github_username: generalSettings.github_username || '',
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

      <button className="btn btn-primary" type="submit" disabled={saving}>
        {saving ? 'Saving…' : saved ? 'Saved!' : 'Save'}
      </button>
    </form>
  );
}
