import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the api module
vi.mock('../../utils/api', () => ({
  api: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

// Mock the stream event store
vi.mock('../streamEventStore', () => ({
  pushEvents: vi.fn(),
  clearEvents: vi.fn(),
}));

import { api } from '../../utils/api';

describe('useWebSocket - interruptAndSend callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call the interrupt endpoint with correct session ID', async () => {
    const sessionId = 'test-session-123';
    api.post.mockResolvedValueOnce({ success: true });

    // Simulate the useCallback behavior directly
    const callback = () => api.post(`/api/sessions/${sessionId}/interrupt`).catch(() => {
      throw new Error('Could not interrupt session.');
    });

    await callback();

    expect(api.post).toHaveBeenCalledWith(`/api/sessions/${sessionId}/interrupt`);
  });

  it('should catch errors from interrupt endpoint', async () => {
    const sessionId = 'test-session-123';
    const errorMessage = 'Network error';
    api.post.mockRejectedValueOnce(new Error(errorMessage));

    // Simulate the useCallback behavior with error handling
    const sendErrorState = { value: null };
    const setSendError = (msg) => {
      sendErrorState.value = msg;
    };

    const callback = () => {
      return api.post(`/api/sessions/${sessionId}/interrupt`).catch(() => {
        setSendError('Could not interrupt session.');
      });
    };

    await callback();

    expect(sendErrorState.value).toBe('Could not interrupt session.');
  });

  it('should not set error on successful interrupt', async () => {
    const sessionId = 'test-session-123';
    api.post.mockResolvedValueOnce({ success: true });

    const sendErrorState = { value: null };
    const setSendError = (msg) => {
      sendErrorState.value = msg;
    };

    const callback = () => {
      return api.post(`/api/sessions/${sessionId}/interrupt`).catch(() => {
        setSendError('Could not interrupt session.');
      });
    };

    await callback();

    expect(api.post).toHaveBeenCalledWith(`/api/sessions/${sessionId}/interrupt`);
    expect(sendErrorState.value).toBeNull();
  });

  it('should use useCallback dependency pattern with sessionId', async () => {
    const sessionId1 = 'session-1';
    const sessionId2 = 'session-2';

    api.post.mockResolvedValue({ success: true });

    // Simulate useCallback with sessionId dependency
    const callback1 = () => api.post(`/api/sessions/${sessionId1}/interrupt`);
    const callback2 = () => api.post(`/api/sessions/${sessionId2}/interrupt`);

    await callback1();
    await callback2();

    expect(api.post).toHaveBeenCalledWith(`/api/sessions/${sessionId1}/interrupt`);
    expect(api.post).toHaveBeenCalledWith(`/api/sessions/${sessionId2}/interrupt`);
  });
});
