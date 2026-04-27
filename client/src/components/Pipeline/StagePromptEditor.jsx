import { useState } from 'react';
import styles from './StagePromptEditor.module.css';

const STAGE_NAMES = {
  1: 'Stage 1: Spec Refinement',
  2: 'Stage 2: QA Design',
  3: 'Stage 3: Implementation Planning',
};

export default function StagePromptEditor({ prompts, onSave }) {
  return (
    <div className={styles.editor}>
      <h3>Stage Prompts</h3>
      <p className={styles.note}>
        These prompts are unique to this pipeline. Editing one only affects this pipeline.
        If a stage hasn't run yet, the next run uses the new prompt. If it has, you'll need to
        reject the stage to re-run with the updated prompt.
      </p>
      {[1, 2, 3].map((stage) => (
        <PromptBlock
          key={stage}
          stage={stage}
          name={STAGE_NAMES[stage]}
          initialPrompt={prompts[String(stage)] || ''}
          onSave={(p) => onSave(stage, p)}
        />
      ))}
    </div>
  );
}

function PromptBlock({ stage, name, initialPrompt, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialPrompt);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.block}>
      <div className={styles.blockHeader}>
        <h4>{name}</h4>
        {!editing && <button onClick={() => { setDraft(initialPrompt); setEditing(true); }}>Edit</button>}
        {savedFlash && <span className={styles.saved}>Saved</span>}
      </div>
      {!editing ? (
        <pre className={styles.preview}>{initialPrompt}</pre>
      ) : (
        <>
          <textarea
            className={styles.textarea}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={20}
          />
          <div className={styles.actions}>
            <button onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
            <button onClick={handleSave} disabled={saving}>Save</button>
          </div>
        </>
      )}
    </div>
  );
}
