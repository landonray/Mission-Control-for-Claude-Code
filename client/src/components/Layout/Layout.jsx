import React from 'react';
import { useParams } from 'react-router-dom';
import SessionList from '../Dashboard/SessionList';
import ChatInterface from '../Chat/ChatInterface';
import FileBrowser from '../FileBrowser/FileBrowser';
import { useApp } from '../../context/AppContext';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import styles from './Layout.module.css';

export default function Layout() {
  const { id } = useParams();
  const { showFileBrowser, dispatch, activeSessionId, sessions } = useApp();

  const sessionId = id || activeSessionId;
  const activeSession = sessions.find(s => s.id === sessionId);

  return (
    <div className={styles.layout}>
      {/* Left Panel: Session List */}
      <div className={styles.leftPanel}>
        <SessionList />
      </div>

      {/* Center Panel: Chat */}
      <div className={styles.centerPanel}>
        {sessionId ? (
          <ChatInterface sessionId={sessionId} />
        ) : (
          <div className="empty-state" style={{ height: '100%' }}>
            <h3>No Session Selected</h3>
            <p>Select a session from the left or create a new one</p>
          </div>
        )}
      </div>

      {/* Right Panel: File Browser */}
      <div className={`${styles.rightPanel} ${showFileBrowser ? '' : styles.collapsed}`}>
        <button
          className={`btn-ghost btn-icon ${styles.toggleBtn}`}
          onClick={() => dispatch({ type: 'TOGGLE_FILE_BROWSER' })}
          title={showFileBrowser ? 'Hide files' : 'Show files'}
        >
          {showFileBrowser ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
        </button>
        {showFileBrowser && (
          <FileBrowser
            directory={activeSession?.working_directory}
          />
        )}
      </div>
    </div>
  );
}
