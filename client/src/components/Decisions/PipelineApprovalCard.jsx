import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../utils/api.js';
import { GitBranch, FileText, Send, Check, RotateCcw } from 'lucide-react';
import styles from './DecisionCard.module.css';

export default function PipelineApprovalCard({ item, onResolved }) {
  const ps = item.pipeline_stage;
  const [chat, setChat] = useState([]);
  const [chatLoading, setChatLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);

  const [stageOutput, setStageOutput] = useState('');
  const [stageOutputLoading, setStageOutputLoading] = useState(true);
  const [showOutput, setShowOutput] = useState(true);

  const [sendBackOpen, setSendBackOpen] = useState(false);
  const [sendBackFeedback, setSendBackFeedback] = useState('');
  const [sendBackLoading, setSendBackLoading] = useState(false);
  const [draftingFeedback, setDraftingFeedback] = useState(false);

  const scrollRef = useRef(null);

  const loadChat = useCallback(async () => {
    try {
      const data = await api.get(`/api/pipelines/${ps.pipeline_id}/approval-chat`);
      setChat(data?.messages || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setChatLoading(false);
    }
  }, [ps.pipeline_id]);

  const loadStageOutput = useCallback(async () => {
    try {
      const data = await api.get(`/api/pipelines/${ps.pipeline_id}/output/${ps.stage}`);
      setStageOutput(data?.content || '');
    } catch (err) {
      setStageOutput('');
    } finally {
      setStageOutputLoading(false);
    }
  }, [ps.pipeline_id, ps.stage]);

  useEffect(() => { loadChat(); loadStageOutput(); }, [loadChat, loadStageOutput]);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat]);

  const sendMessage = async () => {
    if (!draft.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await api.post(`/api/pipelines/${ps.pipeline_id}/approval-chat`, { message: draft.trim() });
      setChat((prev) => [...prev, res.user, res.assistant]);
      setDraft('');
    } catch (err) {
      setError(err.message);
    } finally {
      setPending(false);
    }
  };

  const approve = async () => {
    setPending(true);
    setError(null);
    try {
      await api.post(`/api/pipelines/${ps.pipeline_id}/approve`);
      if (onResolved) await onResolved();
    } catch (err) {
      setError(err.message);
      setPending(false);
    }
  };

  const openSendBack = async () => {
    setError(null);
    if (chat.length === 0) {
      // No chat yet — let the user write feedback by hand.
      setSendBackFeedback('');
      setSendBackOpen(true);
      return;
    }
    // Draft from chat by calling send-back without feedback in dry-mode... but our
    // endpoint commits as soon as feedback is summarized, so instead just open
    // the panel and let the user type. (We could add a /draft-feedback endpoint
    // later if useful.)
    setSendBackFeedback('');
    setSendBackOpen(true);
  };

  const submitSendBack = async () => {
    setSendBackLoading(true);
    setError(null);
    try {
      await api.post(`/api/pipelines/${ps.pipeline_id}/send-back`, {
        feedback: sendBackFeedback.trim() || undefined,
      });
      if (onResolved) await onResolved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSendBackLoading(false);
    }
  };

  const draftFromChat = async () => {
    if (chat.length === 0) return;
    setDraftingFeedback(true);
    try {
      // Lightweight client-side draft: stitch the user messages together so
      // the owner can edit before submitting. The server will summarize via
      // LLM if the user submits with empty feedback.
      const combined = chat
        .filter((m) => m.role === 'user')
        .map((m) => `- ${m.content}`)
        .join('\n');
      setSendBackFeedback(combined);
    } finally {
      setDraftingFeedback(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <GitBranch size={14} />
        <span style={{ background: 'var(--accent-light)', padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>
          Pipeline approval
        </span>
        {item.project_name && <span><strong>{item.project_name}</strong></span>}
        <span>·</span>
        <Link to={`/pipelines/${ps.pipeline_id}`} style={{ color: 'var(--accent)' }}>{ps.pipeline_name}</Link>
        <span>· {new Date(item.created_at).toLocaleString()}</span>
      </div>

      <div className={styles.question}>
        Stage {ps.stage}: {ps.stage_name} ready for approval{ps.iteration > 1 ? ` (iteration ${ps.iteration})` : ''}
      </div>

      {ps.rejection_feedback && (
        <div className={styles.rec}>
          <div className={styles.recLabel}>Previous feedback you sent</div>
          <div>{ps.rejection_feedback}</div>
        </div>
      )}

      {ps.output_path && (
        <div className={styles.workingFiles}>
          <FileText size={12} /> {ps.output_path}
        </div>
      )}

      <details
        open={showOutput}
        onToggle={(e) => setShowOutput(e.currentTarget.open)}
        style={{ marginBottom: 8 }}
      >
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>
          {showOutput ? 'Hide stage output' : 'Show stage output'}
        </summary>
        <pre
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 10,
            maxHeight: 360,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            fontSize: 12,
            marginTop: 8,
          }}
        >
          {stageOutputLoading ? 'Loading…' : (stageOutput || '(no output document)')}
        </pre>
      </details>

      <div className={styles.chat} ref={scrollRef}>
        {chatLoading && <div className={styles.empty}>Loading chat…</div>}
        {!chatLoading && chat.length === 0 && (
          <div className={styles.empty}>Ask the thinking partner about this stage's output before approving or sending back.</div>
        )}
        {chat.map((m) => (
          <div key={m.id} className={`${styles.msg} ${m.role === 'user' ? styles.msgUser : styles.msgAssistant}`}>
            {m.content}
          </div>
        ))}
        {pending && <div className={styles.thinking}>Thinking…</div>}
      </div>

      <div className={styles.input}>
        <textarea
          rows={2}
          placeholder="Ask about this stage, or describe what you want changed"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={pending}
        />
        <button className="btn btn-secondary btn-sm" onClick={sendMessage} disabled={pending || !draft.trim()}>
          <Send size={14} /> Send
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.actions}>
        <button className="btn btn-primary btn-sm" onClick={approve} disabled={pending}>
          <Check size={14} /> Approve stage
        </button>
        <button className="btn btn-ghost btn-sm" onClick={openSendBack} disabled={pending}>
          <RotateCcw size={14} /> Send back with feedback
        </button>
      </div>

      {sendBackOpen && (
        <div className={styles.lockInPanel}>
          <label className={styles.field}>
            <span>
              Feedback for the agent (optional — leave empty to let the thinking partner summarize the chat)
            </span>
            <textarea
              rows={4}
              value={sendBackFeedback}
              onChange={(e) => setSendBackFeedback(e.target.value)}
              placeholder="Be specific. The agent will revise this stage and re-present it."
            />
          </label>
          <div className={styles.actions}>
            <button
              className="btn btn-primary btn-sm"
              onClick={submitSendBack}
              disabled={sendBackLoading}
            >
              {sendBackLoading ? 'Sending back…' : 'Send back'}
            </button>
            {chat.length > 0 && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={draftFromChat}
                disabled={draftingFeedback || sendBackLoading}
              >
                Draft from chat
              </button>
            )}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setSendBackOpen(false)}
              disabled={sendBackLoading}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
