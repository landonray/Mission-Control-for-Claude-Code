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
  const [activeTab, setActiveTab] = useState('claude-code');
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
          <div className={styles.snippetTabs}>
            <button
              className={`${styles.snippetTab} ${activeTab === 'claude-code' ? styles.snippetTabActive : ''}`}
              onClick={() => setActiveTab('claude-code')}
            >
              Claude Code
            </button>
            <button
              className={`${styles.snippetTab} ${activeTab === 'claude-desktop' ? styles.snippetTabActive : ''}`}
              onClick={() => setActiveTab('claude-desktop')}
            >
              Claude Desktop
            </button>
          </div>
          {activeTab === 'claude-code' ? (
            <>
              <pre className={styles.snippet}>
                {JSON.stringify(snippet.claudeCode?.snippet || snippet.snippet, null, 2)}
              </pre>
              <div className={styles.snippetRow}>
                <button
                  className="btn btn-sm"
                  onClick={() => handleCopy(JSON.stringify(snippet.claudeCode?.snippet || snippet.snippet, null, 2))}
                >
                  <Copy size={14} /> {copied ? 'Copied' : 'Copy snippet'}
                </button>
                <span className={styles.snippetHint}>
                  Paste into <code>~/.claude.json</code> or your project's <code>.mcp.json</code>
                </span>
              </div>
            </>
          ) : (
            <>
              <pre className={styles.snippet}>
                {JSON.stringify(snippet.claudeDesktop?.snippet, null, 2)}
              </pre>
              <div className={styles.snippetRow}>
                <button
                  className="btn btn-sm"
                  onClick={() => handleCopy(JSON.stringify(snippet.claudeDesktop?.snippet, null, 2))}
                >
                  <Copy size={14} /> {copied ? 'Copied' : 'Copy snippet'}
                </button>
                <span className={styles.snippetHint}>
                  Paste into <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>
                </span>
              </div>
            </>
          )}
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionLabel}>How to connect</div>

        <div className={styles.guideCard}>
          <div className={styles.guideTitle}>Claude Code (terminal / CLI / IDE extensions)</div>
          <p className={styles.guidePara}>
            Claude Code supports HTTP MCP servers natively. Just paste the snippet and go.
          </p>
          <ol className={styles.guideList}>
            <li>
              Generate a token above. Switch to the <strong>Claude Code</strong> tab and copy the snippet.
            </li>
            <li>
              Open <code>~/.claude.json</code> in any editor.
              For per-project config, use that project's <code>.mcp.json</code> instead.
            </li>
            <li>
              Merge the <code>mcpServers</code> block into the file.
              If <code>mcpServers</code> already exists, add the <code>mission-control</code> entry alongside the others.
            </li>
            <li>
              Restart Claude Code. The tools (<code>mc_list_projects</code>,
              <code> mc_start_session</code>, etc.) appear automatically.
            </li>
          </ol>
        </div>

        <div className={styles.guideCard}>
          <div className={styles.guideTitle}>Claude Desktop (Mac / Windows app)</div>
          <p className={styles.guidePara}>
            Claude Desktop only supports stdio MCP servers — it can't connect to HTTP endpoints directly.
            Mission Control includes a lightweight bridge script (<code>mcp-stdio-bridge.js</code>) that
            translates between Desktop's stdio protocol and the HTTP endpoint.
            The snippet above is pre-configured with the bridge path and your token.
          </p>
          <ol className={styles.guideList}>
            <li>
              Generate a token above. Switch to the <strong>Claude Desktop</strong> tab and copy the snippet.
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
              Merge the <code>mcpServers</code> block into the file.
              If <code>mcpServers</code> already exists, add the <code>mission-control</code> entry alongside the others.
            </li>
            <li>
              <strong>Important:</strong> The <code>command</code> path in the snippet must point to a <code>node</code> binary
              that Claude Desktop can find. The snippet uses the same Node.js that runs this server.
              If your Desktop app can't find it, replace the <code>command</code> value with the full path
              to your <code>node</code> (run <code>which node</code> in terminal to find it).
            </li>
            <li>
              Fully quit and reopen Claude Desktop (<strong>Cmd+Q</strong>, not just close the window).
              The Mission Control tools will appear in any new conversation.
            </li>
          </ol>
          <div className={styles.guideNote}>
            Mission Control must be running on this machine for either client to connect.
            The server is local-only — it won't work from another machine.
          </div>
        </div>
      </div>
    </div>
  );
}
