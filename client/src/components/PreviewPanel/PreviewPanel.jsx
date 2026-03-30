import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import { RotateCw, ExternalLink, Globe, Play, Loader } from 'lucide-react';
import styles from './PreviewPanel.module.css';

export default function PreviewPanel({ sessionId }) {
  const { previewUrls, dispatch, sessions } = useApp();
  const previewUrl = previewUrls[sessionId] || '';
  const [inputUrl, setInputUrl] = useState('');
  const [iframeKey, setIframeKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);

  const activeSession = sessions.find(s => s.id === sessionId);
  const sessionIsActive = activeSession && !['ended', 'error'].includes(activeSession.status);

  // Reset local state when switching sessions
  useEffect(() => {
    setStarting(false);
    setInputUrl('');
  }, [sessionId]);

  const loadPreviewUrl = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await api.get(`/api/sessions/${sessionId}/preview-url`);
      const url = data.preview_url || '';
      setInputUrl(url);
      dispatch({ type: 'SET_PREVIEW_URL', payload: { sessionId, url } });
    } catch (e) {}
  }, [sessionId, dispatch]);

  useEffect(() => {
    loadPreviewUrl();
  }, [loadPreviewUrl]);

  // Sync when previewUrl changes externally (e.g., auto-detected dev server)
  useEffect(() => {
    if (previewUrl && previewUrl !== inputUrl) {
      setInputUrl(previewUrl);
      setIframeKey(k => k + 1);
      setStarting(false);
    }
  }, [previewUrl]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    let url = inputUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//.test(url)) {
      url = 'http://' + url;
      setInputUrl(url);
    }
    setLoading(true);
    dispatch({ type: 'SET_PREVIEW_URL', payload: { sessionId, url } });
    setIframeKey(k => k + 1);
    try {
      await api.put(`/api/sessions/${sessionId}/preview-url`, { url });
    } catch (e) {}
    setLoading(false);
  };

  const handleRefresh = () => {
    setIframeKey(k => k + 1);
  };

  const handleOpenExternal = () => {
    if (previewUrl) {
      window.open(previewUrl, '_blank');
    }
  };

  // Reset starting state if session ends or errors out without detecting a server
  useEffect(() => {
    if (starting && activeSession && ['ended', 'error', 'idle'].includes(activeSession.status)) {
      setStarting(false);
    }
  }, [starting, activeSession?.status]);

  const handleRunServer = async () => {
    if (!sessionId) return;
    setStarting(true);
    try {
      await api.post(`/api/sessions/${sessionId}/message`, {
        content: 'Start the dev server for this project. Look at the project files to determine the correct command (e.g. npm run dev, npm start, python manage.py runserver, etc). Run it in the background so it stays running.'
      });
    } catch (e) {
      setStarting(false);
    }
  };

  return (
    <div className={styles.panel}>
      <form className={styles.toolbar} onSubmit={handleSubmit}>
        <input
          type="text"
          className={`input ${styles.urlInput}`}
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          placeholder="localhost:3000"
        />
        <button
          type="button"
          className={`btn-ghost btn-icon ${styles.toolbarBtn}`}
          onClick={handleRefresh}
          title="Refresh"
          disabled={!previewUrl}
        >
          <RotateCw size={16} />
        </button>
        <button
          type="button"
          className={`btn-ghost btn-icon ${styles.toolbarBtn}`}
          onClick={handleOpenExternal}
          title="Open in browser"
          disabled={!previewUrl}
        >
          <ExternalLink size={16} />
        </button>
      </form>

      <div className={styles.iframeWrap}>
        {previewUrl ? (
          <iframe
            key={iframeKey}
            src={previewUrl}
            className={styles.iframe}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            title="App Preview"
          />
        ) : starting ? (
          <div className={styles.emptyState}>
            <Loader size={48} strokeWidth={1} className={styles.spinner} />
            <p className={styles.startingTitle}>Starting dev server...</p>
            <p className={styles.startingSubtext}>
              Detecting project type and launching server
            </p>
          </div>
        ) : (
          <div className={styles.emptyState}>
            <Globe size={48} strokeWidth={1} />
            {sessionIsActive ? (
              <>
                <p className={styles.emptyTitle}>No server running</p>
                <button
                  className={styles.runButton}
                  onClick={handleRunServer}
                >
                  <Play size={18} />
                  Run Server
                </button>
                <p className={styles.emptyHint}>
                  Or enter a URL above to preview a running app
                </p>
              </>
            ) : (
              <>
                <p className={styles.emptyTitle}>No preview available</p>
                <p className={styles.emptyHint}>
                  Start a session and run a dev server, or enter a URL above
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
