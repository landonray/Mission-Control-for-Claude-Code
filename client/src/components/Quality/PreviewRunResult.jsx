import { CheckCircle, XCircle, AlertTriangle, ChevronLeft } from 'lucide-react';
import styles from './PreviewRunResult.module.css';

export default function PreviewRunResult({ result, onClose }) {
  if (!result) return null;

  const stateIcon = {
    pass: <CheckCircle size={16} className={styles.passIcon} />,
    fail: <XCircle size={16} className={styles.failIcon} />,
    error: <AlertTriangle size={16} className={styles.errorIcon} />,
  };

  const stateClass = {
    pass: styles.pass,
    fail: styles.fail,
    error: styles.error,
  };

  const truncatedEvidence =
    result.evidence && result.evidence.length > 5000
      ? result.evidence.slice(0, 5000) + '…'
      : result.evidence;

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.title}>Preview Result</span>
        <button className={styles.closeBtn} onClick={onClose}>
          <ChevronLeft size={14} />
          Back to Form
        </button>
      </div>

      {/* Verdict */}
      <div className={styles.verdict}>
        {stateIcon[result.state] || stateIcon.error}
        <span className={`${styles.state} ${stateClass[result.state] || ''}`}>
          {(result.state || 'error').toUpperCase()}
        </span>
        {result.duration != null && (
          <span className={styles.duration}>{result.duration}ms</span>
        )}
        {result.estimatedTokenCost && (
          <span className={styles.tokens}>{result.estimatedTokenCost}</span>
        )}
      </div>

      {/* Evidence */}
      {result.evidence && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Evidence</div>
          <pre className={styles.pre}>{truncatedEvidence}</pre>
        </div>
      )}

      {/* Checks */}
      {result.checkResults && result.checkResults.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Checks</div>
          {result.checkResults.map((check, i) => (
            <div key={i} className={styles.checkRow}>
              {check.passed ? (
                <CheckCircle size={12} className={styles.checkPass} />
              ) : (
                <XCircle size={12} className={styles.checkFail} />
              )}
              <span>{check.type || check.description}</span>
              {check.reason && (
                <span className={styles.checkReason}>{check.reason}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Judge Verdict */}
      {result.judgeVerdict && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Judge Verdict</div>
          <div className={styles.judgeRow}>
            <span
              className={`${styles.judgeResult} ${
                result.judgeVerdict.result === 'pass' ? styles.pass : styles.fail
              }`}
            >
              {(result.judgeVerdict.result || '').toUpperCase()}
            </span>
            {result.judgeVerdict.confidence && (
              <span className={styles.judgeConfidence}>
                {result.judgeVerdict.confidence} confidence
              </span>
            )}
          </div>
          {result.judgeVerdict.reasoning && (
            <p className={styles.judgeReasoning}>{result.judgeVerdict.reasoning}</p>
          )}
        </div>
      )}

      {/* Error */}
      {result.error && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Error</div>
          <span className={styles.errorText}>{result.error}</span>
        </div>
      )}
    </div>
  );
}
