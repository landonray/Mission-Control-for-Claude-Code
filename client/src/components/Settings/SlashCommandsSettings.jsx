import React, { useState, useEffect } from 'react';
import { api } from '../../utils/api';
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import styles from './SlashCommandsSettings.module.css';

function MergeFieldsHint({ fields }) {
  if (!fields || fields.length === 0) return null;
  return (
    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
      <strong>Available merge fields</strong>
      <ul style={{ margin: '4px 0 0 0', paddingLeft: 18 }}>
        {fields.map(f => (
          <li key={f.name}>
            <code style={{ background: 'rgba(0,0,0,0.06)', padding: '1px 4px', borderRadius: 3 }}>
              {`{{${f.name}}}`}
            </code> — {f.description}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function SlashCommandsSettings() {
  const [commands, setCommands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', message: '' });
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', message: '' });
  const [error, setError] = useState('');
  const [mergeFieldList, setMergeFieldList] = useState([]);

  const loadCommands = async () => {
    try {
      const result = await api.get('/api/slash-commands');
      setCommands(result.commands);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCommands();
    api.get('/api/merge-fields').then(data => setMergeFieldList(data.fields || [])).catch(() => {});
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/api/slash-commands', createForm);
      setCreateForm({ name: '', message: '' });
      setCreating(false);
      await loadCommands();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleUpdate = async (id) => {
    setError('');
    try {
      await api.put(`/api/slash-commands/${id}`, editForm);
      setEditingId(null);
      await loadCommands();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id, name) => {
    if (!confirm(`Delete the /${name} command?`)) return;
    setError('');
    try {
      await api.delete(`/api/slash-commands/${id}`);
      await loadCommands();
    } catch (err) {
      setError(err.message);
    }
  };

  const startEditing = (cmd) => {
    setEditingId(cmd.id);
    setEditForm({ name: cmd.name, message: cmd.message });
    setCreating(false);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditForm({ name: '', message: '' });
  };

  if (loading) return <div>Loading…</div>;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h2>Slash Commands</h2>
          <p className={styles.hint}>
            Create custom commands you can trigger by typing / in the chat input.
            When you use a command, its configured message is sent automatically.
          </p>
        </div>
        {!creating && (
          <button className="btn btn-primary btn-sm" onClick={() => { setCreating(true); setEditingId(null); }}>
            <Plus size={14} /> New Command
          </button>
        )}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {creating && (
        <form className={styles.form} onSubmit={handleCreate}>
          <div className={styles.formRow}>
            <div className={styles.field}>
              <label>Command Name</label>
              <div className={styles.nameInputWrapper}>
                <span className={styles.slash}>/</span>
                <input
                  className="input"
                  placeholder="e.g. review, deploy, summarize"
                  value={createForm.name}
                  onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
                  autoFocus
                />
              </div>
            </div>
            <div className={styles.fieldWide}>
              <label>Message to Send</label>
              <textarea
                className={`input ${styles.messageInput}`}
                placeholder="The message that will be sent when this command is used…"
                value={createForm.message}
                onChange={e => setCreateForm(f => ({ ...f, message: e.target.value }))}
                rows={3}
              />
              <MergeFieldsHint fields={mergeFieldList} />
            </div>
          </div>
          <div className={styles.formActions}>
            <button className="btn btn-primary btn-sm" type="submit" disabled={!createForm.name.trim() || !createForm.message.trim()}>
              Create Command
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setCreating(false); setCreateForm({ name: '', message: '' }); }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {commands.length === 0 && !creating ? (
        <div className={styles.empty}>
          No slash commands yet. Click "New Command" to create one.
        </div>
      ) : (
        <div className={styles.list}>
          {commands.map(cmd => (
            <div key={cmd.id} className={styles.item}>
              {editingId === cmd.id ? (
                <div className={styles.editRow}>
                  <div className={styles.field}>
                    <label>Command Name</label>
                    <div className={styles.nameInputWrapper}>
                      <span className={styles.slash}>/</span>
                      <input
                        className="input"
                        value={editForm.name}
                        onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                        autoFocus
                      />
                    </div>
                  </div>
                  <div className={styles.fieldWide}>
                    <label>Message to Send</label>
                    <textarea
                      className={`input ${styles.messageInput}`}
                      value={editForm.message}
                      onChange={e => setEditForm(f => ({ ...f, message: e.target.value }))}
                      rows={3}
                    />
                    <MergeFieldsHint fields={mergeFieldList} />
                  </div>
                  <div className={styles.editActions}>
                    <button className="btn-ghost btn-icon" onClick={() => handleUpdate(cmd.id)} title="Save">
                      <Check size={16} />
                    </button>
                    <button className="btn-ghost btn-icon" onClick={cancelEditing} title="Cancel">
                      <X size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className={styles.display}>
                  <div className={styles.cmdInfo}>
                    <span className={styles.cmdName}>/{cmd.name}</span>
                    <span className={styles.cmdMessage}>{cmd.message}</span>
                  </div>
                  <div className={styles.cmdActions}>
                    <button className="btn-ghost btn-icon" onClick={() => startEditing(cmd)} title="Edit">
                      <Pencil size={14} />
                    </button>
                    <button className="btn-ghost btn-icon" onClick={() => handleDelete(cmd.id, cmd.name)} title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
