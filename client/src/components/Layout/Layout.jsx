import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import SessionList from '../Dashboard/SessionList';
import ChatInterface from '../Chat/ChatInterface';
import FileBrowser from '../FileBrowser/FileBrowser';
import PreviewPanel from '../PreviewPanel/PreviewPanel';
import CliPanel from '../CliPanel/CliPanel';
import PillSelector from '../common/PillSelector';
import { useApp } from '../../context/AppContext';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import styles from './Layout.module.css';

const RIGHT_PANEL_TABS = [
  { value: 'files', label: 'Files' },
  { value: 'preview', label: 'Preview' },
  { value: 'cli', label: 'CLI' },
];

const LEFT_DEFAULT = 280;
const RIGHT_DEFAULT = 380;

function readWidth(key, fallback) {
  const v = localStorage.getItem(key);
  return v ? Number(v) : fallback;
}

export default function Layout() {
  const { id } = useParams();
  const { showFileBrowser, rightPanelMode, dispatch, activeSessionId, sessions } = useApp();

  const sessionId = id || activeSessionId;
  const activeSession = sessions.find(s => s.id === sessionId);

  const [leftWidth, setLeftWidth] = useState(() => readWidth('sidebar-left-width', LEFT_DEFAULT));
  const [rightWidth, setRightWidth] = useState(() => readWidth('sidebar-right-width', RIGHT_DEFAULT));
  const [dragging, setDragging] = useState(null); // 'left' | 'right' | null

  const dragRef = useRef({ startX: 0, startWidth: 0 });

  const onMouseDown = useCallback((side, e) => {
    e.preventDefault();
    const currentWidth = side === 'left' ? leftWidth : rightWidth;
    dragRef.current = { startX: e.clientX, startWidth: currentWidth };
    setDragging(side);
  }, [leftWidth, rightWidth]);

  useEffect(() => {
    if (!dragging) return;

    const onMouseMove = (e) => {
      const { startX, startWidth } = dragRef.current;
      const delta = e.clientX - startX;

      if (dragging === 'left') {
        setLeftWidth(startWidth + delta);
      } else {
        // Right panel: dragging left increases width
        setRightWidth(startWidth - delta);
      }
    };

    const onMouseUp = () => {
      setDragging((side) => {
        if (side === 'left') {
          setLeftWidth((w) => { localStorage.setItem('sidebar-left-width', w); return w; });
        } else if (side === 'right') {
          setRightWidth((w) => { localStorage.setItem('sidebar-right-width', w); return w; });
        }
        return null;
      });
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [dragging]);

  return (
    <div className={styles.layout}>
      {/* Left Panel: Session List */}
      <div className={styles.leftPanel} style={{ width: leftWidth }}>
        <SessionList />
      </div>

      {/* Left Resize Handle */}
      <div
        className={`${styles.resizeHandle} ${dragging === 'left' ? styles.active : ''}`}
        onMouseDown={(e) => onMouseDown('left', e)}
      />

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

      {/* Right Resize Handle */}
      {showFileBrowser && sessionId && (
        <div
          className={`${styles.resizeHandle} ${dragging === 'right' ? styles.active : ''}`}
          onMouseDown={(e) => onMouseDown('right', e)}
        />
      )}

      {/* Right Panel: Files / Preview */}
      <div
        className={`${styles.rightPanel} ${showFileBrowser && sessionId ? '' : styles.collapsed}`}
        style={showFileBrowser && sessionId ? { width: rightWidth } : undefined}
      >
        {sessionId && !showFileBrowser && (
          <button
            className={`btn-ghost btn-icon ${styles.toggleBtn}`}
            onClick={() => dispatch({ type: 'TOGGLE_FILE_BROWSER' })}
            title="Show panel"
          >
            <PanelRightOpen size={18} />
          </button>
        )}
        {showFileBrowser && sessionId && (
          <>
            <div className={styles.panelHeader}>
              <button
                className="btn-ghost btn-icon"
                onClick={() => dispatch({ type: 'TOGGLE_FILE_BROWSER' })}
                title="Hide panel"
              >
                <PanelRightClose size={18} />
              </button>
              <div className={styles.panelTabs}>
                <PillSelector
                  options={RIGHT_PANEL_TABS}
                  value={rightPanelMode}
                  onChange={(mode) => dispatch({ type: 'SET_RIGHT_PANEL_MODE', payload: mode })}
                />
              </div>
            </div>
            {activeSession?.status === 'ended' ? (
              <div className="empty-state" style={{ height: '100%' }}>
                <p>Session ended</p>
              </div>
            ) : rightPanelMode === 'files' ? (
              <FileBrowser directory={activeSession?.working_directory} useWorktree={!!activeSession?.use_worktree} />
            ) : rightPanelMode === 'preview' ? (
              <PreviewPanel sessionId={sessionId} />
            ) : (
              <CliPanel sessionId={sessionId} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
