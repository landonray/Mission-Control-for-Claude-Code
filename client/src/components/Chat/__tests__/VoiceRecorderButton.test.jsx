// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import VoiceRecorderButton from '../VoiceRecorderButton';

let mockHookState;
vi.mock('../../../hooks/useVoiceRecorder', () => ({
  useVoiceRecorder: ({ onTranscription }) => {
    mockHookState.onTranscription = onTranscription;
    return mockHookState;
  },
}));

function setHook(overrides) {
  mockHookState = {
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
    setHook();
    global.MediaRecorder = function () {};
  });

  it('renders a mic button in idle state', () => {
    render(<VoiceRecorderButton onTranscription={vi.fn()} />);
    expect(screen.getByRole('button', { name: /record voice/i })).toBeInTheDocument();
  });

  it('calls start() when the mic button is clicked', () => {
    render(<VoiceRecorderButton onTranscription={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /record voice/i }));
    expect(mockHookState.start).toHaveBeenCalledTimes(1);
  });

  it('shows a stop button and timer while recording', () => {
    setHook({ state: 'recording', elapsedSeconds: 8 });
    render(<VoiceRecorderButton onTranscription={vi.fn()} />);
    expect(screen.getByRole('button', { name: /stop recording/i })).toBeInTheDocument();
    expect(screen.getByText('0:08')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel recording/i })).toBeInTheDocument();
  });

  it('calls stop() when the stop button is clicked', () => {
    setHook({ state: 'recording', elapsedSeconds: 3 });
    render(<VoiceRecorderButton onTranscription={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /stop recording/i }));
    expect(mockHookState.stop).toHaveBeenCalledTimes(1);
  });

  it('calls cancel() when the cancel (X) button is clicked', () => {
    setHook({ state: 'recording', elapsedSeconds: 3 });
    render(<VoiceRecorderButton onTranscription={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel recording/i }));
    expect(mockHookState.cancel).toHaveBeenCalledTimes(1);
  });

  it('shows a spinner while transcribing', () => {
    setHook({ state: 'transcribing' });
    render(<VoiceRecorderButton onTranscription={vi.fn()} />);
    expect(screen.getByLabelText(/transcribing/i)).toBeInTheDocument();
  });

  it('shows the error and a dismiss button when state is error', () => {
    setHook({ state: 'error', error: 'Microphone access denied. Enable it in your browser settings.' });
    render(<VoiceRecorderButton onTranscription={vi.fn()} />);
    expect(screen.getByText(/microphone access denied/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(mockHookState.clearError).toHaveBeenCalledTimes(1);
  });

  it('passes onTranscription through to the hook', () => {
    const onTranscription = vi.fn();
    render(<VoiceRecorderButton onTranscription={onTranscription} />);
    act(() => { mockHookState.onTranscription('hello'); });
    expect(onTranscription).toHaveBeenCalledWith('hello');
  });

  it('renders nothing when MediaRecorder is unsupported', () => {
    const original = global.MediaRecorder;
    delete global.MediaRecorder;
    delete window.MediaRecorder;
    const { container } = render(<VoiceRecorderButton onTranscription={vi.fn()} />);
    expect(container.firstChild).toBeNull();
    global.MediaRecorder = original;
  });
});
