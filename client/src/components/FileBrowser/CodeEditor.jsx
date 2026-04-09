import React, { useState, useRef, useCallback, useEffect } from 'react';
import { api } from '../../utils/api';
import { Save, X } from 'lucide-react';
import styles from './CodeEditor.module.css';

export default function CodeEditor({ code, filePath, onSave, onCancel }) {
  const [value, setValue] = useState(code || '');
  const [status, setStatus] = useState(null); // null | 'saving' | 'saved' | 'error'
  const [errorMsg, setErrorMsg] = useState('');
  const textareaRef = useRef(null);
  const lineNumbersRef = useRef(null);

  const lineCount = value.split('\n').length;
  const hasChanges = value !== code;

  // Sync scroll between line numbers and textarea
  const handleScroll = useCallback(() => {
    if (lineNumbersRef.current && textareaRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  // Handle tab key for indentation
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = e.target.selectionStart;
      const end = e.target.selectionEnd;
      const newValue = value.substring(0, start) + '  ' + value.substring(end);
      setValue(newValue);
      // Restore cursor position after React re-render
      requestAnimationFrame(() => {
        e.target.selectionStart = e.target.selectionEnd = start + 2;
      });
    }
    // Ctrl/Cmd+S to save
    if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
  }, [value]);

  const handleSave = async () => {
    setStatus('saving');
    setErrorMsg('');
    try {
      await api.put('/api/files/content', { path: filePath, content: value });
      setStatus('saved');
      if (onSave) onSave(value);
      setTimeout(() => setStatus(null), 2000);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err.message);
    }
  };

  // Focus textarea on mount
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

  return (
    <div className={styles.container}>
      <div className={styles.editorWrapper}>
        <div className={styles.lineNumbers} ref={lineNumbersRef}>
          {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
        </div>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={value}
          onChange={(e) => { setValue(e.target.value); setStatus(null); }}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>
      <div className={styles.toolbar}>
        <button className="btn btn-sm btn-primary" onClick={handleSave} disabled={!hasChanges || status === 'saving'}>
          <Save size={12} /> Save
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>
          <X size={12} /> Cancel
        </button>
        {status && (
          <span className={`${styles.status} ${styles[status]}`}>
            {status === 'saving' && 'Saving...'}
            {status === 'saved' && 'Saved!'}
            {status === 'error' && (errorMsg || 'Save failed')}
          </span>
        )}
        {!status && hasChanges && (
          <span className={styles.status}>Unsaved changes</span>
        )}
      </div>
    </div>
  );
}
