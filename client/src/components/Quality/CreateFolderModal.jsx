import React, { useState } from 'react';
import { X } from 'lucide-react';
import styles from './CreateFolderModal.module.css';

export default function CreateFolderModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Folder name is required');
      return;
    }
    if (/[\/\\\.]+/.test(name.trim()) || name.includes('..')) {
      setError('Invalid folder name');
      return;
    }
    setError(null);
    setCreating(true);
    try {
      await onCreate(name.trim());
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to create folder');
    }
    setCreating(false);
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>New Eval Folder</h3>
          <button className={styles.closeBtn} onClick={onClose}><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label className={styles.label}>Folder Name</label>
            <input
              className={styles.input}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. api-checks"
              autoFocus
            />
          </div>
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>Cancel</button>
            <button type="submit" className={styles.createBtn} disabled={creating}>
              {creating ? 'Creating...' : 'Create Folder'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
