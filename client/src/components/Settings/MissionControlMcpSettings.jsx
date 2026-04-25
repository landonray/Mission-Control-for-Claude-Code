import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../utils/api';
import { Copy, Plus, Trash2, Server } from 'lucide-react';
import styles from './MissionControlMcpSettings.module.css';

export default function MissionControlMcpSettings() {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newlyCreated, setNewlyCreated] = useState(null);
  const [snippet, setSnippet] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const loadTokens = useCallback(async () => {
    try {
      setError(null);
      const data = await api.get('/api/mcp-tokens');
      setTokens(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const created = await api.post('/api/mcp-tokens', { name: 'Default' });
      setNewlyCreated({ token: created.token, name: created.name });
      const snip = await api.get(
        `/api/mcp-tokens/connect-snippet?token=${encodeURIComponent(created.token)}`
      );
      setSnippet(snip);
      await loadTokens();
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (tokenId) => {
    if (!confirm('Revoke this token? Any Claude Code session using it will lose access.')) return;
    try {
      await api.post(`/api/mcp-tokens/${tokenId}/revoke`, {});
      await loadTokens();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // noop
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2><Server size={18} /> Mission Control MCP</h2>
        <p className={styles.subtitle}>
          Generate one app-wide token, paste it into Claude Code's MCP config, and any Claude Code
          session anywhere on this machine can call into Mission Control. Claude Code will use
          <code> mc_list_projects</code> to find the right project, then call
          <code> mc_start_session</code> for product or architecture questions instead of asking you.
        </p>
      </div>

      {error && <div className={styles.errorBlock}>{error}</div>}

      <div className={styles.section}>
        <div className={styles.sectionRow}>
          <div className={styles.sectionLabel}>Tokens</div>
          <button className="btn btn-primary btn-sm" onClick={handleCreate} disabled={creating}>
            <Plus size={14} /> {creating ? 'Creating…' : 'Generate token'}
          </button>
        </div>

        {loading ? (
          <div className={styles.empty}>Loading…</div>
        ) : tokens.length === 0 ? (
          <div className={styles.empty}>No tokens yet. Generate one to connect Claude Code.</div>
        ) : (
          <ul className={styles.tokenList}>
            {tokens.map((t) => (
              <li key={t.id} className={styles.tokenRow}>
                <span
                  className={`${styles.tokenStatus} ${t.active ? styles.active : styles.revoked}`}
                >
                  {t.active ? 'active' : 'revoked'}
                </span>
                <span className={styles.tokenName}>{t.name}</span>
                <span className={styles.tokenMeta}>
                  created {new Date(t.created_at).toLocaleDateString()}
                  {t.last_used_at && ` · last used ${new Date(t.last_used_at).toLocaleString()}`}
                </span>
                {t.active && (
                  <button
                    className="btn btn-ghost btn-icon"
                    title="Revoke"
                    onClick={() => handleRevoke(t.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {newlyCreated && snippet && (
        <div className={styles.snippetBlock}>
          <div className={styles.snippetHeader}>
            <strong>Token created — copy it now, it won't be shown again.</strong>
          </div>
          <pre className={styles.snippet}>{JSON.stringify(snippet.snippet, null, 2)}</pre>
          <div className={styles.snippetRow}>
            <button
              className="btn btn-sm"
              onClick={() => handleCopy(JSON.stringify(snippet.snippet, null, 2))}
            >
              <Copy size={14} /> {copied ? 'Copied' : 'Copy snippet'}
            </button>
            <span className={styles.snippetHint}>
              Use the snippet below to wire it into Claude Code or Claude Desktop.
            </span>
          </div>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionLabel}>How to connect</div>

        <div className={styles.guideCard}>
          <div className={styles.guideTitle}>Claude Code (terminal)</div>
          <ol className={styles.guideList}>
            <li>
              Generate a token above and copy the JSON snippet.
            </li>
            <li>
              Open <code>~/.claude.json</code> (your global Claude Code config) in any editor.
              If a project should have its own config, use that project's <code>.mcp.json</code> instead.
            </li>
            <li>
              Merge the <code>mcpServers</code> block from the snippet into the file.
              If <code>mcpServers</code> already exists, just add the <code>mission-control</code> entry alongside the others.
            </li>
            <li>
              Restart Claude Code. The Mission Control tools (<code>mc_list_projects</code>,
              <code> mc_start_session</code>, etc.) will appear automatically.
            </li>
          </ol>
        </div>

        <div className={styles.guideCard}>
          <div className={styles.guideTitle}>Claude Desktop (Mac / Windows app)</div>
          <ol className={styles.guideList}>
            <li>
              Generate a token above and copy the JSON snippet.
            </li>
            <li>
              Open the Claude Desktop config file:
              <ul className={styles.guideSubList}>
                <li>
                  <strong>macOS:</strong> <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>
                </li>
                <li>
                  <strong>Windows:</strong> <code>%APPDATA%\Claude\claude_desktop_config.json</code>
                </li>
              </ul>
              If the file doesn't exist yet, create it with <code>{'{}'}</code> as the contents.
            </li>
            <li>
              Merge the <code>mcpServers</code> block from the snippet into the file.
              If <code>mcpServers</code> already exists, just add the <code>mission-control</code> entry alongside the others.
            </li>
            <li>
              Fully quit and reopen Claude Desktop (don't just close the window — use Quit).
              The Mission Control tools will show up under the connectors menu in any chat.
            </li>
          </ol>
          <div className={styles.guideNote}>
            Note: Mission Control needs to be running on this machine for either app to reach it.
            If you point Claude Desktop at <code>http://localhost:3001/mcp</code> from another machine
            it won't connect — the server is local-only.
          </div>
        </div>
      </div>
    </div>
  );
}
