import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import { Plus, Edit2, Trash2, Globe, Clock, Plane, Server, Folder, Save, X } from 'lucide-react';
import FolderPicker from '../shared/FolderPicker';
import styles from './PresetsManager.module.css';

const iconOptions = [
  { value: 'globe', Icon: Globe },
  { value: 'clock', Icon: Clock },
  { value: 'plane', Icon: Plane },
  { value: 'server', Icon: Server },
  { value: 'folder', Icon: Folder },
];

const iconMap = { globe: Globe, clock: Clock, plane: Plane, server: Server, folder: Folder };

export default function PresetsManager() {
  const { presets, loadPresets } = useApp();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({
    name: '', description: '', working_directory: '',
    permission_mode: 'default', initial_prompt: '', icon: 'folder',
    mcp_connections: '',
  });

  const startEdit = (preset) => {
    setEditing(preset ? preset.id : 'new');
    setForm(preset ? {
      name: preset.name,
      description: preset.description || '',
      working_directory: preset.working_directory,
      permission_mode: preset.permission_mode || 'default',
      initial_prompt: preset.initial_prompt || '',
      icon: preset.icon || 'folder',
      mcp_connections: preset.mcp_connections || '',
      claude_md_path: preset.claude_md_path || '',
    } : {
      name: '', description: '', working_directory: '',
      permission_mode: 'default', initial_prompt: '', icon: 'folder',
      mcp_connections: '', claude_md_path: '',
    });
  };

  const handleSave = async () => {
    try {
      const data = {
        ...form,
        mcp_connections: form.mcp_connections
          ? form.mcp_connections.split(',').map(s => s.trim()).filter(Boolean)
          : null,
        claude_md_path: form.claude_md_path || null,
      };

      if (editing === 'new') {
        await api.post('/api/presets', data);
      } else {
        await api.put(`/api/presets/${editing}`, data);
      }
      await loadPresets();
      setEditing(null);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this preset?')) return;
    try {
      await api.delete(`/api/presets/${id}`);
      await loadPresets();
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div className={styles.manager}>
      <div className={styles.header}>
        <h3>Project Presets</h3>
        <button className="btn btn-primary btn-sm" onClick={() => startEdit(null)}>
          <Plus size={14} /> Add Preset
        </button>
      </div>

      <div className={styles.list}>
        {presets.map(preset => {
          const Icon = iconMap[preset.icon] || Folder;
          return (
            <div key={preset.id} className={styles.presetItem}>
              <Icon size={20} className={styles.presetIcon} />
              <div className={styles.presetInfo}>
                <span className={styles.presetName}>{preset.name}</span>
                <span className={styles.presetPath}>{preset.working_directory}</span>
                {preset.description && (
                  <span className={styles.presetDesc}>{preset.description}</span>
                )}
              </div>
              <div className={styles.presetActions}>
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => startEdit(preset)}>
                  <Edit2 size={14} />
                </button>
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => handleDelete(preset.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <div className={styles.editOverlay} onClick={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className={styles.editPanel}>
            <div className={styles.editHeader}>
              <h4>{editing === 'new' ? 'New Preset' : 'Edit Preset'}</h4>
              <button className="btn btn-ghost btn-icon" onClick={() => setEditing(null)}>
                <X size={16} />
              </button>
            </div>

            <div className={styles.editForm}>
              <div className={styles.field}>
                <label>Name</label>
                <input className="input" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>

              <div className={styles.field}>
                <label>Description</label>
                <input className="input" value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
              </div>

              <div className={styles.field}>
                <label>Working Directory</label>
                <FolderPicker
                  value={form.working_directory}
                  onChange={v => setForm(f => ({ ...f, working_directory: v }))}
                  placeholder="~/projects/my-project"
                />
              </div>

              <div className={styles.field}>
                <label>Icon</label>
                <div className={styles.iconPicker}>
                  {iconOptions.map(({ value, Icon }) => (
                    <button
                      key={value}
                      className={`${styles.iconBtn} ${form.icon === value ? styles.selectedIcon : ''}`}
                      onClick={() => setForm(f => ({ ...f, icon: value }))}
                      type="button"
                    >
                      <Icon size={18} />
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.field}>
                <label>Permission Mode</label>
                <select className="input" value={form.permission_mode}
                  onChange={e => setForm(f => ({ ...f, permission_mode: e.target.value }))}>
                  <option value="acceptEdits">Accept Edits (default)</option>
                  <option value="auto">Auto Mode (classifier-based)</option>
                  <option value="plan">Plan Mode (read-only)</option>
                  <option value="default">Prompt for Everything</option>
                </select>
              </div>

              <div className={styles.field}>
                <label>MCP Connections (comma-separated)</label>
                <input className="input" value={form.mcp_connections}
                  onChange={e => setForm(f => ({ ...f, mcp_connections: e.target.value }))}
                  placeholder="ontraport-mcp, other-mcp" />
              </div>

              <div className={styles.field}>
                <label>CLAUDE.md Reference Path</label>
                <input className="input" value={form.claude_md_path}
                  onChange={e => setForm(f => ({ ...f, claude_md_path: e.target.value }))}
                  placeholder="~/projects/my-project/CLAUDE.md" />
              </div>

              <div className={styles.field}>
                <label>Initial Prompt</label>
                <textarea className="input" value={form.initial_prompt}
                  onChange={e => setForm(f => ({ ...f, initial_prompt: e.target.value }))}
                  rows={3} placeholder="Optional startup prompt..." />
              </div>

              <button className="btn btn-primary" onClick={handleSave} style={{ width: '100%' }}>
                <Save size={14} /> Save Preset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
