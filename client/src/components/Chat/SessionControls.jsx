import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../utils/api';
import { useApp } from '../../context/AppContext';
import { Pause, Play, Square, MoreVertical, Server, Power, PowerOff } from 'lucide-react';
import PillSelector from '../common/PillSelector';
import WorktreeCleanupModal from './WorktreeCleanupModal';
import styles from './SessionControls.module.css';

export default function SessionControls({ sessionId, status, session }) {
  const navigate = useNavigate();
  const { loadSessions, mcpServers, loadMcpServers } = useApp();
  const [showMenu, setShowMenu] = useState(false);
  const [permissionMode, setPermissionMode] = useState(session?.permission_mode || 'auto');

  // Reset permission mode when session changes
  useEffect(() => {
    setPermissionMode(session?.permission_mode || 'auto');
  }, [sessionId, session?.permission_mode]);

  useEffect(() => {
    loadMcpServers();
  }, []);

  const handlePause = async () => {
    await api.post(`/api/sessions/${sessionId}/pause`);
    loadSessions();
  };

  const handleResume = async () => {
    await api.post(`/api/sessions/${sessionId}/resume`);
    loadSessions();
  };

  const [showCleanupModal, setShowCleanupModal] = useState(false);

  const handleEnd = async () => {
    if (session?.use_worktree) {
      try {
        const status = await api.get(`/api/sessions/${sessionId}/worktree-status`);
        if (status.hasUncommittedChanges) {
          setShowCleanupModal(true);
          return;
        }
        await api.post(`/api/sessions/${sessionId}/end`, { cleanup: true });
        loadSessions();
        navigate('/');
        return;
      } catch (e) {
        // If status check fails, just end normally
      }
    }
    await api.post(`/api/sessions/${sessionId}/end`);
    loadSessions();
    navigate('/');
  };

  const handleCleanupChoice = async (choice) => {
    let body = {};
    if (choice === 'commit') {
      body = { commit: true, cleanup: true };
    } else if (choice === 'delete') {
      body = { cleanup: true };
    }
    await api.post(`/api/sessions/${sessionId}/end`, body);
    setShowCleanupModal(false);
    loadSessions();
    navigate('/');
  };

  const changePermissionMode = async (mode) => {
    setPermissionMode(mode);
    await api.post(`/api/sessions/${sessionId}/permission-mode`, { permissionMode: mode });
  };

  const toggleMcpAutoConnect = async (serverId) => {
    try {
      await api.post(`/api/mcp/${serverId}/toggle-auto-connect`);
      await loadMcpServers();
    } catch (e) {}
  };

  if (status === 'ended') return null;

  return (
    <div className={styles.controls}>
      {status === 'paused' ? (
        <button className="btn btn-ghost btn-sm" onClick={handleResume} title="Resume">
          <Play size={14} /> Resume
        </button>
      ) : (
        <button className="btn btn-ghost btn-sm" onClick={handlePause} title="Pause">
          <Pause size={14} />
        </button>
      )}

      <button className="btn btn-ghost btn-sm" onClick={handleEnd} title="End session">
        <Square size={14} />
      </button>

      <div className={styles.menuWrapper}>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setShowMenu(!showMenu)}>
          <MoreVertical size={14} />
        </button>

        {showMenu && (
          <>
            <div className={styles.menuBackdrop} onClick={() => setShowMenu(false)} />
            <div className={styles.menu}>
              <div className={styles.menuLabel}>Permission Mode</div>
              <div style={{ padding: '0 8px 8px' }}>
                <PillSelector
                  options={[
                    { value: 'plan', label: 'Plan' },
                    { value: 'default', label: 'Ask' },
                    { value: 'acceptEdits', label: 'Edits' },
                    { value: 'auto', label: 'Auto' },
                    { value: 'bypassPermissions', label: 'YOLO' },
                  ]}
                  value={permissionMode}
                  onChange={changePermissionMode}
                />
              </div>

              {mcpServers.length > 0 && (
                <>
                  <div className={styles.menuDivider} />
                  <div className={styles.menuLabel}>
                    <Server size={12} /> MCP Servers
                  </div>
                  {mcpServers.map(server => (
                    <button
                      key={server.id}
                      className={styles.menuItem}
                      onClick={() => toggleMcpAutoConnect(server.id)}
                    >
                      {server.auto_connect ? <Power size={14} style={{ color: 'var(--success)' }} /> : <PowerOff size={14} />}
                      <span>{server.name}</span>
                      <span className={`${styles.indicator} ${server.auto_connect ? styles.on : ''}`} />
                    </button>
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {showCleanupModal && (
        <WorktreeCleanupModal
          onChoice={handleCleanupChoice}
          onClose={() => setShowCleanupModal(false)}
        />
      )}
    </div>
  );
}
