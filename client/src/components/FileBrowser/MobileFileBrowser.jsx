import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import FileBrowser from './FileBrowser';
import styles from './MobileFileBrowser.module.css';

export default function MobileFileBrowser() {
  const { id } = useParams();
  const { sessions, activeSessionId, dispatch } = useApp();
  const [customPath, setCustomPath] = useState('');

  useEffect(() => {
    if (id) {
      dispatch({ type: 'SET_ACTIVE_SESSION', payload: id });
    }
  }, [id, dispatch]);

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const directory = activeSession?.working_directory || customPath;

  return (
    <div className={styles.container}>
      {!directory && (
        <div className={styles.pathInput}>
          <input
            className="input"
            placeholder="Enter directory path (e.g. ~/projects/my-app)"
            value={customPath}
            onChange={e => setCustomPath(e.target.value)}
          />
        </div>
      )}
      {directory ? (
        <FileBrowser directory={directory} />
      ) : (
        <div className="empty-state" style={{ padding: '32px 16px' }}>
          <p>Enter a directory path or start a session to browse files</p>
        </div>
      )}
    </div>
  );
}
