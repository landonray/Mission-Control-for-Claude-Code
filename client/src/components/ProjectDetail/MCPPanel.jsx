import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../utils/api';
import { Copy, Plus, Trash2, MessageSquare, BookOpen } from 'lucide-react';
import styles from './MCPPanel.module.css';

export default function MCPPanel({ projectId, projectName }) {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newlyCreated, setNewlyCreated] = useState(null); // { token, name } — visible once
  const [error, setError] = useState(null);
  const [snippet, setSnippet] = useState(null);
  const [copied, setCopied] = useState(false);
  const [questions, setQuestions] = useState([]);
  const [decisionsState, setDecisionsState] = useState({ exists: false, entries: [], path: null });

  const loadTokens = useCallback(async () => {
    try {
      setError(null);
      const data = await api.get(`/api/mcp-tokens/${projectId}`);
      setTokens(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadQuestions = useCallback(async () => {
    try {
      const data = await api.get(`/api/planning/questions?project_id=${projectId}&limit=10`);
      setQuestions(data);
    } catch {
      // best-effort
    }
  }, [projectId]);

  const loadDecisions = useCallback(async () => {
    try {
      const data = await api.get(`/api/planning/decisions/${projectId}`);
      setDecisionsState(data);
    } catch {
      // best-effort
    }
  }, [projectId]);

  useEffect(() => {
    loadTokens();
    loadQuestions();
    loadDecisions();
  }, [loadTokens, loadQuestions, loadDecisions]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const created = await api.post(`/api/mcp-tokens/${projectId}`, { name: 'Default' });
      setNewlyCreated({ token: created.token, name: created.name });
      // Fetch the connect snippet so the user sees it ready-to-paste
      const snip = await api.get(`/api/mcp-tokens/${projectId}/connect-snippet?token=${encodeURIComponent(created.token)}`);
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
      await api.post(`/api/mcp-tokens/${projectId}/${tokenId}/revoke`, {});
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

  const activeTokens = tokens.filter(t => t.active);

  return (
    <div className={styles.panel}>
      <div className={styles.row}>
        <div className={styles.intro}>
          Mission Control exposes a planning loop to Claude Code through MCP. Generate a project token, paste the snippet into the project's <code>.mcp.json</code>, and Claude Code will be able to call <code>mc_start_session</code> to escalate product / architecture questions instead of asking you.
        </div>
      </div>

      {error && <div className={styles.errorBlock}>{error}</div>}

      <div className={styles.tokenSection}>
        <div className={styles.sectionRow}>
          <div className={styles.sectionLabel}>Connection tokens</div>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleCreate}
            disabled={creating}
          >
            <Plus size={14} /> {creating ? 'Creating…' : 'Generate token'}
          </button>
        </div>

        {loading ? (
          <div className={styles.empty}>Loading…</div>
        ) : tokens.length === 0 ? (
          <div className={styles.empty}>No tokens yet. Generate one to connect Claude Code.</div>
        ) : (
          <ul className={styles.tokenList}>
            {tokens.map(t => (
              <li key={t.id} className={styles.tokenRow}>
                <span className={`${styles.tokenStatus} ${t.active ? styles.active : styles.revoked}`}>
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
            <button className="btn btn-sm" onClick={() => handleCopy(JSON.stringify(snippet.snippet, null, 2))}>
              <Copy size={14} /> {copied ? 'Copied' : 'Copy snippet'}
            </button>
            <span className={styles.snippetHint}>
              Paste into the project's <code>.mcp.json</code> (create the file if it doesn't exist), then restart Claude Code in that project.
            </span>
          </div>
        </div>
      )}

      <div className={styles.activitySection}>
        <div className={styles.sectionLabel}>
          <MessageSquare size={14} /> Recent planning queries ({questions.length})
        </div>
        {questions.length === 0 ? (
          <div className={styles.empty}>No planning questions yet. Once Claude Code is connected and asks a planning question, it will appear here.</div>
        ) : (
          <ul className={styles.questionList}>
            {questions.map(q => (
              <li key={q.id} className={styles.questionItem}>
                <div className={styles.questionHeader}>
                  <span className={`${styles.questionStatus} ${styles[`q_${q.status}`]}`}>{q.status}</span>
                  <span className={styles.questionTime}>{new Date(q.asked_at).toLocaleString()}</span>
                </div>
                <div className={styles.questionText}>{q.question}</div>
                {q.answer && (
                  <details className={styles.answerDetails}>
                    <summary>Answer</summary>
                    <div className={styles.answerText}>{q.answer}</div>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.activitySection}>
        <div className={styles.sectionLabel}>
          <BookOpen size={14} /> docs/decisions.md
        </div>
        {decisionsState.exists ? (
          <div className={styles.decisionInfo}>
            {decisionsState.entries.length} entries logged · <code>{decisionsState.path}</code>
          </div>
        ) : (
          <div className={styles.empty}>
            No decisions log yet. Mission Control will create <code>docs/decisions.md</code> in the project repo when the first planning question is answered.
          </div>
        )}
      </div>
    </div>
  );
}
