import React from 'react';
import { Mic, Square, X, Loader } from 'lucide-react';
import { useVoiceRecorder } from '../../hooks/useVoiceRecorder';
import styles from './VoiceRecorderButton.module.css';

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function VoiceRecorderButton({ onTranscription, disabled }) {
  const supported = typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined';
  const recorder = useVoiceRecorder({ onTranscription });

  if (!supported) return null;

  if (recorder.state === 'error') {
    return (
      <div className={styles.errorBar}>
        <span>{recorder.error}</span>
        <button
          className={styles.errorDismiss}
          onClick={recorder.clearError}
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    );
  }

  if (recorder.state === 'transcribing') {
    return (
      <button className={styles.micBtn} disabled aria-label="Transcribing">
        <Loader size={16} className="animate-spin" />
      </button>
    );
  }

  if (recorder.state === 'recording' || recorder.state === 'requesting-permission') {
    return (
      <div className={styles.wrapper}>
        <span className={styles.recordingPill}>
          <span className={styles.recordingDot} />
          <span>{formatTime(recorder.elapsedSeconds)}</span>
        </span>
        <button
          className={styles.cancelBtn}
          onClick={recorder.cancel}
          aria-label="Cancel recording"
          title="Cancel"
        >
          <X size={16} />
        </button>
        <button
          className={styles.stopBtn}
          onClick={recorder.stop}
          aria-label="Stop recording"
          title="Stop & send"
        >
          <Square size={16} />
        </button>
      </div>
    );
  }

  return (
    <button
      className={styles.micBtn}
      onClick={recorder.start}
      disabled={disabled}
      aria-label="Record voice"
      title="Record voice message"
    >
      <Mic size={16} />
    </button>
  );
}
