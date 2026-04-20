import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_RECORDING_MS = 2 * 60 * 1000;

export function useVoiceRecorder({ onTranscription }) {
  const [state, setState] = useState('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState(null);

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef(null);
  const autoStopRef = useRef(null);
  const cancelledRef = useRef(false);

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
  }, []);

  useEffect(() => () => cleanupStream(), [cleanupStream]);

  const uploadAndTranscribe = useCallback(async (blob) => {
    setState('transcribing');
    try {
      const form = new FormData();
      form.append('file', blob, 'audio.webm');
      const res = await fetch('/api/transcribe', { method: 'POST', body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Transcription failed' }));
        throw new Error(body.error || `Transcription failed (${res.status})`);
      }
      const { text } = await res.json();
      const trimmed = (text || '').trim();
      if (!trimmed) {
        setError("Didn't catch that — try again");
        setState('error');
        return;
      }
      setState('idle');
      setError(null);
      onTranscription(trimmed);
    } catch (err) {
      setError(err.message || 'Transcription failed');
      setState('error');
    }
  }, [onTranscription]);

  const start = useCallback(async () => {
    if (state === 'recording' || state === 'transcribing') return;
    setError(null);
    setElapsedSeconds(0);
    chunksRef.current = [];
    cancelledRef.current = false;
    setState('requesting-permission');

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      setError('Microphone requires a secure connection. Open this app at http://localhost (not a network IP), or use HTTPS.');
      setState('error');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cancelledRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        setState('idle');
        return;
      }
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        cleanupStream();
        if (cancelledRef.current) {
          setState('idle');
          return;
        }
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        uploadAndTranscribe(blob);
      };
      recorder.onerror = () => {
        cleanupStream();
        setError('Recording error');
        setState('error');
      };

      recorder.start();
      startedAtRef.current = Date.now();
      setState('recording');

      tickRef.current = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 200);

      autoStopRef.current = setTimeout(() => {
        if (recorderRef.current && recorderRef.current.state === 'recording') {
          recorderRef.current.stop();
        }
      }, MAX_RECORDING_MS);
    } catch (err) {
      cleanupStream();
      if (err && err.name === 'NotAllowedError') {
        setError('Microphone access denied. Enable it in your browser settings.');
      } else {
        setError(err.message || 'Could not start microphone');
      }
      setState('error');
    }
  }, [state, cleanupStream, uploadAndTranscribe]);

  const stop = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== 'recording') return;
    rec.stop();
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const rec = recorderRef.current;
    if (rec && rec.state === 'recording') {
      rec.stop();
    } else {
      cleanupStream();
      setState('idle');
    }
  }, [cleanupStream]);

  const clearError = useCallback(() => {
    setError(null);
    setState('idle');
  }, []);

  return { state, elapsedSeconds, error, start, stop, cancel, clearError };
}
