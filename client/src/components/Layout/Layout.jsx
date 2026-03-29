import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import SessionList from '../Dashboard/SessionList';
import ChatInterface from '../Chat/ChatInterface';
import FileBrowser from '../FileBrowser/FileBrowser';
import PreviewPanel from '../PreviewPanel/PreviewPanel';
import PillSelector from '../common/PillSelector';
import { useApp } from '../../context/AppContext';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import styles from './Layout.module.css';

const RIGHT_PANEL_TABS = [
  { value: 'files', label: 'Files' },
  { value: 'preview', label: 'Preview' },
];

const LEFT_DEFAULT = 280;
const RIGHT_DEFAULT = 380;
const LEFT_MIN = 200;
const LEFT_MAX = 500;
const RIGHT_MIN = 280;
const RIGHT_MAX = 600;

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
        const newWidth = Math.min(LEFT_MAX, Math.max(LEFT_MIN, startWidth + delta));
        setLeftWidth(newWidth);
      } else {
        // Right panel: dragging left increases width
        const newWidth = Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, startWidth - delta));
        setRightWidth(newWidth);
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
      {showFileBrowser && (
        <div
          className={`${styles.resizeHandle} ${dragging === 'right' ? styles.active : ''}`}
          onMouseDown={(e) => onMouseDown('right', e)}
        />
      )}

      {/* Right Panel: Files / Preview */}
      <div
        className={`${styles.rightPanel} ${showFileBrowser ? '' : styles.collapsed}`}
        style={showFileBrowser ? { width: rightWidth } : undefined}
      >
        <button
          className={`btn-ghost btn-icon ${styles.toggleBtn}`}
          onClick={() => dispatch({ type: 'TOGGLE_FILE_BROWSER' })}
          title={showFileBrowser ? 'Hide panel' : 'Show panel'}
        >
          {showFileBrowser ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
        </button>
        {showFileBrowser && (
          <>
            <div className={styles.panelTabs}>
              <PillSelector
                options={RIGHT_PANEL_TABS}
                value={rightPanelMode}
                onChange={(mode) => dispatch({ type: 'SET_RIGHT_PANEL_MODE', payload: mode })}
              />
            </div>
            {rightPanelMode === 'files' ? (
              <FileBrowser directory={activeSession?.working_directory} />
            ) : (
              <PreviewPanel sessionId={sessionId} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
