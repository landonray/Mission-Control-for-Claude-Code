// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mocks — vi.mock is hoisted, so use vi.hoisted for shared references
const { mockNavigate, mockApi, mockLoadSessions, mockLoadMcpServers } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockApi: { get: vi.fn(), post: vi.fn() },
  mockLoadSessions: vi.fn(),
  mockLoadMcpServers: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('../../../utils/api', () => ({
  api: mockApi,
}));

vi.mock('../../../context/AppContext', () => ({
  useApp: () => ({
    loadSessions: mockLoadSessions,
    mcpServers: [],
    loadMcpServers: mockLoadMcpServers,
  }),
}));

// Lucide icons — render as simple spans
vi.mock('lucide-react', () => ({
  Pause: (props) => React.createElement('span', { 'data-testid': 'icon-pause', ...props }),
  Play: (props) => React.createElement('span', { 'data-testid': 'icon-play', ...props }),
  Square: (props) => React.createElement('span', { 'data-testid': 'icon-square', ...props }),
  MoreVertical: (props) => React.createElement('span', { 'data-testid': 'icon-more', ...props }),
  Server: (props) => React.createElement('span', { 'data-testid': 'icon-server', ...props }),
  Power: (props) => React.createElement('span', { 'data-testid': 'icon-power', ...props }),
  PowerOff: (props) => React.createElement('span', { 'data-testid': 'icon-poweroff', ...props }),
  AlertTriangle: (props) => React.createElement('span', { 'data-testid': 'icon-alert', ...props }),
  GitCommit: (props) => React.createElement('span', { 'data-testid': 'icon-gitcommit', ...props }),
  Trash2: (props) => React.createElement('span', { 'data-testid': 'icon-trash', ...props }),
  MinusCircle: (props) => React.createElement('span', { 'data-testid': 'icon-minus', ...props }),
  GitPullRequest: (props) => React.createElement('span', { 'data-testid': 'icon-gitpr', ...props }),
  GitBranch: (props) => React.createElement('span', { 'data-testid': 'icon-gitbranch', ...props }),
}));

// Mock CSS modules
vi.mock('../SessionControls.module.css', () => ({ default: {} }));
vi.mock('../WorktreeCleanupModal.module.css', () => ({ default: {} }));

// Mock PillSelector
vi.mock('../../common/PillSelector', () => ({
  default: () => React.createElement('div', { 'data-testid': 'pill-selector' }),
}));

import SessionControls from '../SessionControls';

describe('Worktree Cleanup Integration', () => {
  const sessionId = 'test-session-123';

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.post.mockResolvedValue({ success: true });
  });

  it('shows modal when ending session with uncommitted changes', async () => {
    mockApi.get.mockResolvedValueOnce({ hasUncommittedChanges: true });

    render(
      <SessionControls
        sessionId={sessionId}
        status="active"
        session={{ use_worktree: true }}
      />
    );

    // Click End button
    fireEvent.click(screen.getByTitle('End session'));

    // Modal should appear
    await waitFor(() => {
      expect(screen.getByText('Uncommitted Changes')).toBeInTheDocument();
    });

    // All three options should be visible
    expect(screen.getByText('Commit & Keep Branch')).toBeInTheDocument();
    expect(screen.getByText('Delete Everything')).toBeInTheDocument();
    expect(screen.getByText('Leave As-Is')).toBeInTheDocument();

    // Verify the status check was called
    expect(mockApi.get).toHaveBeenCalledWith(`/api/sessions/${sessionId}/worktree-status`);
  });

  it('does not show modal for clean worktrees — silently cleans up', async () => {
    mockApi.get.mockResolvedValueOnce({ hasUncommittedChanges: false });

    render(
      <SessionControls
        sessionId={sessionId}
        status="active"
        session={{ use_worktree: true }}
      />
    );

    fireEvent.click(screen.getByTitle('End session'));

    // Should end with cleanup: true, no modal
    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        `/api/sessions/${sessionId}/end`,
        { cleanup: true }
      );
    });

    // Modal should NOT be present
    expect(screen.queryByText('Uncommitted Changes')).not.toBeInTheDocument();

    // Should navigate to dashboard
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('"Commit & Keep Branch" sends correct API params', async () => {
    mockApi.get.mockResolvedValueOnce({ hasUncommittedChanges: true });

    render(
      <SessionControls
        sessionId={sessionId}
        status="active"
        session={{ use_worktree: true }}
      />
    );

    fireEvent.click(screen.getByTitle('End session'));

    await waitFor(() => {
      expect(screen.getByText('Commit & Keep Branch')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Commit & Keep Branch'));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        `/api/sessions/${sessionId}/end`,
        { commit: true, cleanup: true }
      );
    });

    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('"Delete Everything" sends correct API params', async () => {
    mockApi.get.mockResolvedValueOnce({ hasUncommittedChanges: true });

    render(
      <SessionControls
        sessionId={sessionId}
        status="active"
        session={{ use_worktree: true }}
      />
    );

    fireEvent.click(screen.getByTitle('End session'));

    await waitFor(() => {
      expect(screen.getByText('Delete Everything')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Delete Everything'));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        `/api/sessions/${sessionId}/end`,
        { cleanup: true }
      );
    });

    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('"Leave As-Is" sends empty body', async () => {
    mockApi.get.mockResolvedValueOnce({ hasUncommittedChanges: true });

    render(
      <SessionControls
        sessionId={sessionId}
        status="active"
        session={{ use_worktree: true }}
      />
    );

    fireEvent.click(screen.getByTitle('End session'));

    await waitFor(() => {
      expect(screen.getByText('Leave As-Is')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Leave As-Is'));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        `/api/sessions/${sessionId}/end`,
        {}
      );
    });

    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('session ends even if cleanup API call fails', async () => {
    mockApi.get.mockResolvedValueOnce({ hasUncommittedChanges: true });
    // First end call fails (with cleanup)
    mockApi.post.mockRejectedValueOnce(new Error('cleanup failed'));
    // Fallback end call succeeds
    mockApi.post.mockResolvedValueOnce({ success: true });

    render(
      <SessionControls
        sessionId={sessionId}
        status="active"
        session={{ use_worktree: true }}
      />
    );

    fireEvent.click(screen.getByTitle('End session'));

    await waitFor(() => {
      expect(screen.getByText('Commit & Keep Branch')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Commit & Keep Branch'));

    // Should fall back to ending without cleanup params
    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        `/api/sessions/${sessionId}/end`
      );
    });

    // Should still navigate to dashboard
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('non-worktree session ends normally without status check', async () => {
    render(
      <SessionControls
        sessionId={sessionId}
        status="active"
        session={{ use_worktree: false }}
      />
    );

    fireEvent.click(screen.getByTitle('End session'));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(`/api/sessions/${sessionId}/end`);
    });

    // No worktree status check should have been made
    expect(mockApi.get).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('shows PR warning when ending session with open PR and no uncommitted changes', async () => {
    mockApi.get.mockResolvedValueOnce({
      hasUncommittedChanges: false,
      openPR: { number: 42, title: 'Add feature X', url: 'https://github.com/user/repo/pull/42' },
    });

    render(
      <SessionControls
        sessionId={sessionId}
        status="active"
        session={{ use_worktree: true }}
      />
    );

    fireEvent.click(screen.getByTitle('End session'));

    await waitFor(() => {
      expect(screen.getByText('Open Pull Request')).toBeInTheDocument();
    });

    expect(screen.getByText(/Add feature X/)).toBeInTheDocument();
    expect(screen.getByText(/#42/)).toBeInTheDocument();
    expect(screen.getByText('Keep Branch')).toBeInTheDocument();
    expect(screen.getByText('Delete Branch')).toBeInTheDocument();
    expect(screen.getByText('Leave As-Is')).toBeInTheDocument();
  });

  it('shows combined warning when ending session with uncommitted changes AND open PR', async () => {
    mockApi.get.mockResolvedValueOnce({
      hasUncommittedChanges: true,
      openPR: { number: 42, title: 'Add feature X', url: 'https://github.com/user/repo/pull/42' },
    });

    render(
      <SessionControls
        sessionId={sessionId}
        status="active"
        session={{ use_worktree: true }}
      />
    );

    fireEvent.click(screen.getByTitle('End session'));

    await waitFor(() => {
      expect(screen.getByText('Uncommitted Changes')).toBeInTheDocument();
    });

    expect(screen.getByText(/open pull request/i)).toBeInTheDocument();
    expect(screen.getByText(/#42/)).toBeInTheDocument();
    expect(screen.getByText('Commit & Keep Branch')).toBeInTheDocument();
    expect(screen.getByText('Delete Everything')).toBeInTheDocument();
    expect(screen.getByText('Leave As-Is')).toBeInTheDocument();
  });

  it('"Keep Branch" sends keepBranch flag for PR-only scenario', async () => {
    mockApi.get.mockResolvedValueOnce({
      hasUncommittedChanges: false,
      openPR: { number: 42, title: 'Add feature X', url: 'https://github.com/user/repo/pull/42' },
    });

    render(
      <SessionControls
        sessionId={sessionId}
        status="active"
        session={{ use_worktree: true }}
      />
    );

    fireEvent.click(screen.getByTitle('End session'));

    await waitFor(() => {
      expect(screen.getByText('Keep Branch')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Keep Branch'));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        `/api/sessions/${sessionId}/end`,
        { cleanup: true, keepBranch: true }
      );
    });

    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('"Delete Branch" for PR-only scenario sends cleanup without keepBranch', async () => {
    mockApi.get.mockResolvedValueOnce({
      hasUncommittedChanges: false,
      openPR: { number: 42, title: 'Add feature X', url: 'https://github.com/user/repo/pull/42' },
    });

    render(
      <SessionControls
        sessionId={sessionId}
        status="active"
        session={{ use_worktree: true }}
      />
    );

    fireEvent.click(screen.getByTitle('End session'));

    await waitFor(() => {
      expect(screen.getByText('Delete Branch')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Delete Branch'));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        `/api/sessions/${sessionId}/end`,
        { cleanup: true }
      );
    });

    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('silently cleans up when no uncommitted changes and no PR', async () => {
    mockApi.get.mockResolvedValueOnce({
      hasUncommittedChanges: false,
      openPR: null,
    });

    render(
      <SessionControls
        sessionId={sessionId}
        status="active"
        session={{ use_worktree: true }}
      />
    );

    fireEvent.click(screen.getByTitle('End session'));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        `/api/sessions/${sessionId}/end`,
        { cleanup: true }
      );
    });

    expect(screen.queryByText('Open Pull Request')).not.toBeInTheDocument();
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
