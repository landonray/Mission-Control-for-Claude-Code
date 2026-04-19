// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceRecorder } from '../useVoiceRecorder';

class FakeMediaRecorder {
  static instances = [];
  constructor(stream, opts) {
    this.stream = stream;
    this.opts = opts;
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    FakeMediaRecorder.instances.push(this);
  }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob(['audio-bytes'], { type: 'audio/webm' }) });
    }
    if (this.onstop) this.onstop();
  }
}

function mockGetUserMedia(result) {
  const stream = { getTracks: () => [{ stop: vi.fn() }] };
  const getUserMedia = vi.fn().mockImplementation(() =>
    result === 'grant' ? Promise.resolve(stream) : Promise.reject(new DOMException('denied', 'NotAllowedError'))
  );
  Object.defineProperty(global.navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  return getUserMedia;
}

describe('useVoiceRecorder', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    global.MediaRecorder = FakeMediaRecorder;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('starts in idle state', () => {
    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder({ onTranscription }));
    expect(result.current.state).toBe('idle');
    expect(result.current.elapsedSeconds).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('transitions to recording on start() when permission is granted', async () => {
    mockGetUserMedia('grant');
    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder({ onTranscription }));

    await act(async () => { await result.current.start(); });

    expect(result.current.state).toBe('recording');
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  it('moves to error state when permission is denied', async () => {
    mockGetUserMedia('deny');
    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder({ onTranscription }));

    await act(async () => { await result.current.start(); });

    expect(result.current.state).toBe('error');
    expect(result.current.error).toMatch(/microphone/i);
  });

  it('stop() uploads audio and calls onTranscription with the returned text', async () => {
    mockGetUserMedia('grant');
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'hello from whisper' }),
    });
    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder({ onTranscription }));

    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });

    expect(global.fetch).toHaveBeenCalledWith('/api/transcribe', expect.objectContaining({ method: 'POST' }));
    expect(onTranscription).toHaveBeenCalledWith('hello from whisper');
    expect(result.current.state).toBe('idle');
  });

  it('stop() with empty transcription sets error state and does NOT call onTranscription', async () => {
    mockGetUserMedia('grant');
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '   ' }),
    });
    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder({ onTranscription }));

    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });

    expect(onTranscription).not.toHaveBeenCalled();
    expect(result.current.state).toBe('error');
    expect(result.current.error).toMatch(/didn't catch/i);
  });

  it('stop() with a failed HTTP response sets error state', async () => {
    mockGetUserMedia('grant');
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'gateway exploded' }),
    });
    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder({ onTranscription }));

    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });

    expect(onTranscription).not.toHaveBeenCalled();
    expect(result.current.state).toBe('error');
    expect(result.current.error).toMatch(/gateway exploded/i);
  });

  it('cancel() returns to idle without calling fetch', async () => {
    mockGetUserMedia('grant');
    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder({ onTranscription }));

    await act(async () => { await result.current.start(); });
    act(() => { result.current.cancel(); });

    expect(result.current.state).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(onTranscription).not.toHaveBeenCalled();
  });

  it('clearError() returns to idle from error state', async () => {
    mockGetUserMedia('deny');
    const onTranscription = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder({ onTranscription }));

    await act(async () => { await result.current.start(); });
    expect(result.current.state).toBe('error');

    act(() => { result.current.clearError(); });

    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
  });
});
