import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../utils/api';
import { MessageSquare, BookOpen, Settings as SettingsIcon } from 'lucide-react';
import styles from './MCPPanel.module.css';

export default function MCPPanel({ projectId }) {
  const [questions, setQuestions] = useState([]);
  const [decisionsState, setDecisionsState] = useState({ exists: false, entries: [], path: null });

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
    loadQuestions();
    loadDecisions();
  }, [loadQuestions, loadDecisions]);

  return (
    <div className={styles.panel}>
      <div className={styles.row}>
        <div className={styles.intro}>
          Planning questions Claude Code escalated for this project, plus the running log of
          answered decisions. Manage the global MCP token in{' '}
          <Link to="/settings" className={styles.link}>
            <SettingsIcon size={12} /> Settings → Mission Control MCP
          </Link>.
        </div>
      </div>

      <div className={styles.activitySection}>
        <div className={styles.sectionLabel}>
          <MessageSquare size={14} /> Recent planning queries ({questions.length})
        </div>
        {questions.length === 0 ? (
          <div className={styles.empty}>
            No planning questions yet. Once Claude Code is connected and asks a planning question
            about this project, it will appear here.
          </div>
        ) : (
          <ul className={styles.questionList}>
            {questions.map((q) => (
              <li key={q.id} className={styles.questionItem}>
                <div className={styles.questionHeader}>
                  <span className={`${styles.questionStatus} ${styles[`q_${q.status}`]}`}>
                    {q.status}
                  </span>
                  <span className={styles.questionTime}>
                    {new Date(q.asked_at).toLocaleString()}
                  </span>
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
            No decisions log yet. Mission Control will create <code>docs/decisions.md</code> in the
            project repo when the first planning question is answered.
          </div>
        )}
      </div>
    </div>
  );
}
