import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import { RotateCw, ExternalLink, Globe } from 'lucide-react';
import styles from './PreviewPanel.module.css';

export default function PreviewPanel({ sessionId }) {
  const { previewUrl, dispatch } = useApp();
  const [inputUrl, setInputUrl] = useState('');
  const [iframeKey, setIframeKey] = useState(0);
  const [loading, setLoading] = useState(false);

  const loadPreviewUrl = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await api.get(`/api/sessions/${sessionId}/preview-url`);
      const url = data.preview_url || '';
      setInputUrl(url);
      dispatch({ type: 'SET_PREVIEW_URL', payload: url });
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
    dispatch({ type: 'SET_PREVIEW_URL', payload: url });
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
        ) : (
          <div className={styles.emptyState}>
            <Globe size={48} strokeWidth={1} />
            <p>Enter a URL above to preview your running app</p>
          </div>
        )}
      </div>
    </div>
  );
}
