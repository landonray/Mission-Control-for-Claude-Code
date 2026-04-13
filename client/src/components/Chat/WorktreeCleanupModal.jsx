import React, { useState } from 'react';
import { AlertTriangle, GitCommit, Trash2, MinusCircle, GitPullRequest, GitBranch } from 'lucide-react';
import styles from './WorktreeCleanupModal.module.css';

export default function WorktreeCleanupModal({ onChoice, onClose, hasUncommittedChanges, openPR }) {
  const [loading, setLoading] = useState(null);

  const handleChoice = async (choice) => {
    setLoading(choice);
    try {
      await onChoice(choice);
    } catch (e) {
      setLoading(null);
    }
  };

  const prOnly = !hasUncommittedChanges && openPR;

  return (
    <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        <div className={styles.header}>
          {prOnly ? (
            <>
              <GitPullRequest size={18} style={{ color: 'var(--accent)' }} />
              <h3>Open Pull Request</h3>
            </>
          ) : (
            <>
              <AlertTriangle size={18} style={{ color: 'var(--warning, #f39c12)' }} />
              <h3>Uncommitted Changes</h3>
            </>
          )}
        </div>
        <div className={styles.body}>
          {prOnly ? (
            <>This branch has an open pull request. Ending this session will delete the branch unless you choose to keep it.</>
          ) : hasUncommittedChanges && openPR ? (
            <>This session has uncommitted changes in the worktree. This branch also has an open pull request.</>
          ) : (
            <>This session has uncommitted changes in the worktree. What would you like to do?</>
          )}
          {openPR && (
            <div className={styles.prInfo}>
              <GitPullRequest size={14} />
              <span>#{openPR.number}: {openPR.title}</span>
            </div>
          )}
        </div>
        <div className={styles.actions}>
          {prOnly ? (
            <>
              <button
                className={`${styles.actionBtn} ${styles.commitBtn}`}
                onClick={() => handleChoice('keepBranch')}
                disabled={loading !== null}
              >
                <GitBranch size={16} />
                <div>
                  Keep Branch
                  <div className={styles.actionDesc}>Remove worktree but keep the branch and PR open</div>
                </div>
              </button>

              <button
                className={`${styles.actionBtn} ${styles.deleteBtn}`}
                onClick={() => handleChoice('delete')}
                disabled={loading !== null}
              >
                <Trash2 size={16} />
                <div>
                  Delete Branch
                  <div className={styles.actionDesc}>Delete the branch — the PR will be closed by GitHub</div>
                </div>
              </button>
            </>
          ) : (
            <>
              <button
                className={`${styles.actionBtn} ${styles.commitBtn}`}
                onClick={() => handleChoice('commit')}
                disabled={loading !== null}
              >
                <GitCommit size={16} />
                <div>
                  Commit & Keep Branch
                  <div className={styles.actionDesc}>
                    Save changes to the branch for future work
                    {openPR && ' — PR stays open'}
                  </div>
                </div>
              </button>

              <button
                className={`${styles.actionBtn} ${styles.deleteBtn}`}
                onClick={() => handleChoice('delete')}
                disabled={loading !== null}
              >
                <Trash2 size={16} />
                <div>
                  Delete Everything
                  <div className={styles.actionDesc}>
                    Discard changes and remove the branch permanently
                    {openPR && ' — PR will be closed by GitHub'}
                  </div>
                </div>
              </button>
            </>
          )}

          <button
            className={`${styles.actionBtn} ${styles.leaveBtn}`}
            onClick={() => handleChoice('leave')}
            disabled={loading !== null}
          >
            <MinusCircle size={16} />
            <div>
              Leave As-Is
              <div className={styles.actionDesc}>End session without cleaning up</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
