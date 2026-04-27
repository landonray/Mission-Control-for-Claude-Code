// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePendingDecisionsCount } from '../usePendingDecisionsCount.js';
import { api } from '../../utils/api.js';

vi.mock('../../utils/api.js', () => ({
  api: { get: vi.fn() },
}));

class StubWebSocket {
  constructor() {}
  close() {}
  set onmessage(_fn) {}
  set onopen(_fn) {}
}
globalThis.WebSocket = StubWebSocket;

describe('usePendingDecisionsCount', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.get.mockResolvedValue({ count: 4 });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('fetches the count on mount', async () => {
    const { result } = renderHook(() => usePendingDecisionsCount());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.count).toBe(4);
    expect(api.get).toHaveBeenCalledWith('/api/decisions/pending/count');
  });

  it('polls every 30 seconds', async () => {
    const { result } = renderHook(() => usePendingDecisionsCount());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.get).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('exposes a refresh function', async () => {
    const { result } = renderHook(() => usePendingDecisionsCount());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.count).toBe(4);
    api.get.mockResolvedValue({ count: 7 });
    await act(async () => { await result.current.refresh(); });
    expect(result.current.count).toBe(7);
  });
});
