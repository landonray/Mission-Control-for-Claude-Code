// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VoiceRecorderButton from '../VoiceRecorderButton';

function makeRecorder(overrides) {
  return {
    state: 'idle',
    elapsedSeconds: 0,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    clearError: vi.fn(),
    ...overrides,
  };
}

describe('VoiceRecorderButton', () => {
  beforeEach(() => {
    global.MediaRecorder = function () {};
  });

  it('renders a mic button in idle state', () => {
    render(<VoiceRecorderButton recorder={makeRecorder()} />);
    expect(screen.getByRole('button', { name: /record voice/i })).toBeInTheDocument();
  });

  it('calls start() when the mic button is clicked', () => {
    const recorder = makeRecorder();
    render(<VoiceRecorderButton recorder={recorder} />);
    fireEvent.click(screen.getByRole('button', { name: /record voice/i }));
    expect(recorder.start).toHaveBeenCalledTimes(1);
  });

  it('shows timer and cancel button (but no stop button) while recording', () => {
    const recorder = makeRecorder({ state: 'recording', elapsedSeconds: 8 });
    render(<VoiceRecorderButton recorder={recorder} />);
    expect(screen.getByText('0:08')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel recording/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stop recording/i })).not.toBeInTheDocument();
  });

  it('calls cancel() when the cancel (X) button is clicked', () => {
    const recorder = makeRecorder({ state: 'recording', elapsedSeconds: 3 });
    render(<VoiceRecorderButton recorder={recorder} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel recording/i }));
    expect(recorder.cancel).toHaveBeenCalledTimes(1);
  });

  it('shows a spinner while transcribing', () => {
    const recorder = makeRecorder({ state: 'transcribing' });
    render(<VoiceRecorderButton recorder={recorder} />);
    expect(screen.getByLabelText(/transcribing/i)).toBeInTheDocument();
  });

  it('shows the error and a dismiss button when state is error', () => {
    const recorder = makeRecorder({ state: 'error', error: 'Microphone access denied. Enable it in your browser settings.' });
    render(<VoiceRecorderButton recorder={recorder} />);
    expect(screen.getByText(/microphone access denied/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(recorder.clearError).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when MediaRecorder is unsupported', () => {
    const original = global.MediaRecorder;
    delete global.MediaRecorder;
    delete window.MediaRecorder;
    const { container } = render(<VoiceRecorderButton recorder={makeRecorder()} />);
    expect(container.firstChild).toBeNull();
    global.MediaRecorder = original;
  });
});
