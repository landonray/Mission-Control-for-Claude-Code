import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../utils/api.js';
import { AlertTriangle, FileText, Send, Check, X } from 'lucide-react';
import styles from './DecisionCard.module.css';

export default function DecisionCard({ item, onResolved }) {
  const [chat, setChat] = useState([]);
  const [chatLoading, setChatLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);

  const [lockInOpen, setLockInOpen] = useState(false);
  const [lockInAnswer, setLockInAnswer] = useState('');
  const [lockInReasoning, setLockInReasoning] = useState('');
  const [addToDoc, setAddToDoc] = useState('neither');
  const [lockInLoading, setLockInLoading] = useState(false);

  const scrollRef = useRef(null);

  const loadChat = useCallback(async () => {
    try {
      const data = await api.get(`/api/planning/escalations/${item.id}/chat`);
      setChat(data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setChatLoading(false);
    }
  }, [item.id]);

  useEffect(() => { loadChat(); }, [loadChat]);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat]);

  const sendMessage = async () => {
    if (!draft.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await api.post(`/api/planning/escalations/${item.id}/chat`, { message: draft.trim() });
      setChat((prev) => [...prev, res.user, res.assistant]);
      setDraft('');
    } catch (err) {
      setError(err.message);
    } finally {
      setPending(false);
    }
  };

  const openLockIn = async () => {
    setLockInLoading(true);
    setError(null);
    try {
      const drafted = await api.post(`/api/planning/escalations/${item.id}/draft-answer`);
      setLockInAnswer(drafted.answer || item.escalation_recommendation || '');
      setLockInReasoning(drafted.reasoning_summary || '');
      setLockInOpen(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLockInLoading(false);
    }
  };

  const confirmLockIn = async () => {
    if (!lockInAnswer.trim()) return;
    setLockInLoading(true);
    setError(null);
    try {
      await api.post(`/api/planning/escalations/${item.id}/finalize`, {
        answer: lockInAnswer.trim(),
        reasoning_summary: lockInReasoning.trim(),
        addToContextDoc: addToDoc,
      });
      if (onResolved) await onResolved();
    } catch (err) {
      setError(err.message);
    } finally {
      setLockInLoading(false);
    }
  };

  const dismiss = async () => {
    if (!window.confirm('Dismiss this question? The asking session will see "dismissed".')) return;
    setPending(true);
    try {
      await api.post(`/api/planning/escalations/${item.id}/dismiss`);
      if (onResolved) await onResolved();
    } catch (err) {
      setError(err.message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <AlertTriangle size={14} />
        {item.project_name && <span><strong>{item.project_name}</strong></span>}
        <span>· session <code>{(item.asking_session_id || 'unknown').slice(0, 8)}</code></span>
        <span>· {new Date(item.asked_at).toLocaleString()}</span>
      </div>

      <div className={styles.question}>{item.question}</div>

      <div className={styles.rec}>
        <div className={styles.recLabel}>Planning agent's recommendation</div>
        <div>{item.escalation_recommendation || '(none)'}</div>
        {item.escalation_reason && (
          <div className={styles.recLabel}><strong>Why escalated:</strong> {item.escalation_reason}</div>
        )}
      </div>

      {item.escalation_context && (
        <details className={styles.context}>
          <summary>Context the planning agent had</summary>
          <div>{item.escalation_context}</div>
        </details>
      )}

      {item.working_files && item.working_files.length > 0 && (
        <div className={styles.workingFiles}>
          <FileText size={12} /> {item.working_files.join(', ')}
        </div>
      )}

      <div className={styles.chat} ref={scrollRef}>
        {chatLoading && <div className={styles.empty}>Loading chat…</div>}
        {!chatLoading && chat.length === 0 && (
          <div className={styles.empty}>Ask a question to start thinking through this decision with an LLM.</div>
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
          placeholder="Ask a question or push back on the recommendation"
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
        <button className="btn btn-primary btn-sm" onClick={openLockIn} disabled={lockInLoading}>
          <Check size={14} /> {lockInLoading ? 'Drafting…' : 'Lock in answer'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={dismiss} disabled={pending}>
          <X size={14} /> Dismiss
        </button>
      </div>

      {lockInOpen && (
        <div className={styles.lockInPanel}>
          <label className={styles.field}>
            <span>Final answer (sent to the asking session)</span>
            <textarea rows={3} value={lockInAnswer} onChange={(e) => setLockInAnswer(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>Reasoning summary (saved to decisions.md)</span>
            <textarea rows={2} value={lockInReasoning} onChange={(e) => setLockInReasoning(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>Also add to</span>
            <select value={addToDoc} onChange={(e) => setAddToDoc(e.target.value)}>
              <option value="neither">Neither (just decisions.md)</option>
              <option value="PRODUCT.md">PRODUCT.md</option>
              <option value="ARCHITECTURE.md">ARCHITECTURE.md</option>
            </select>
          </label>
          <div className={styles.actions}>
            <button className="btn btn-primary btn-sm" onClick={confirmLockIn} disabled={lockInLoading || !lockInAnswer.trim()}>
              {lockInLoading ? 'Submitting…' : 'Confirm'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setLockInOpen(false)} disabled={lockInLoading}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
