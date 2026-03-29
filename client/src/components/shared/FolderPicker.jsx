import React from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import { FolderOpen } from 'lucide-react';
import styles from './FolderPicker.module.css';

export default function FolderPicker({ value, onChange, placeholder = '~/projects/my-project', disabled }) {
  const { pickerAvailable } = useApp();

  const handleBrowse = async () => {
    try {
      const { path } = await api.post('/api/files/pick-directory', {});
      if (path) onChange(path);
    } catch {
      // User cancelled — do nothing
    }
  };

  if (!pickerAvailable) {
    return (
      <input
        className="input"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
      />
    );
  }

  return (
    <div className={styles.pickerRow}>
      <div className={`input ${styles.pathDisplay} ${!value ? styles.placeholder : ''}`}>
        {value || placeholder}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={handleBrowse}
        disabled={disabled}
        title="Browse for folder"
      >
        <FolderOpen size={16} />
        Browse…
      </button>
    </div>
  );
}
