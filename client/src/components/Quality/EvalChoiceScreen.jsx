import { ChevronLeft, Sparkles, PenTool } from 'lucide-react';
import styles from './EvalChoiceScreen.module.css';

export default function EvalChoiceScreen({ folderName, onChooseAI, onChooseManual, onClose }) {
  return (
    <div className={styles.container}>
      <button className={styles.backButton} onClick={onClose} type="button">
        <ChevronLeft size={14} />
        Back to folders
      </button>
      <h3 className={styles.heading}>
        New Eval in <span className={styles.folderRef}>{folderName}</span>
      </h3>
      <div className={styles.choices}>
        <button className={styles.aiButton} onClick={onChooseAI}>
          <Sparkles size={20} />
          <span className={styles.aiLabel}>Build with AI</span>
          <span className={styles.aiHint}>Describe what to check in plain English</span>
        </button>
        <button className={styles.manualLink} onClick={onChooseManual}>
          <PenTool size={14} />
          Build manually
        </button>
      </div>
    </div>
  );
}
