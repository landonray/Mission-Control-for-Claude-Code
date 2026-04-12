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
  Zap: (props) => React.createElement('span', { 'data-testid': 'icon-zap', ...props }),
}));

// Mock CSS modules
vi.mock('../SessionControls.module.css', () => ({ default: {} }));
vi.mock('../WorktreeCleanupModal.module.css', () => ({ default: {} }));

// Mock PillSelector
vi.mock('../../common/PillSelector', () => ({
  default: () => React.createElement('div', { 'data-testid': 'pill-selector' }),
}));

import SessionControls from '../SessionControls';

describe('Max Effort Toggle', () => {
  const sessionId = 'test-session-123';

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.post.mockResolvedValue({ success: true });
  });

  function renderControls(sessionOverrides = {}) {
    const session = {
      permission_mode: 'auto',
      max_effort: 0,
      use_worktree: false,
      ...sessionOverrides,
    };
    return render(
      <SessionControls sessionId={sessionId} status="working" session={session} />
    );
  }

  function openMenu() {
    // Click the three-dot menu button
    const menuBtn = screen.getByTitle('') || screen.getAllByRole('button').find(
      btn => btn.querySelector('[data-testid="icon-more"]')
    );
    fireEvent.click(menuBtn);
  }

  it('renders Max Effort toggle in the dropdown menu', () => {
    renderControls();
    openMenu();
    expect(screen.getByText('Max Effort')).toBeInTheDocument();
  });

  it('shows toggle as off when max_effort is 0', () => {
    renderControls({ max_effort: 0 });
    openMenu();
    expect(screen.getByText('Max Effort')).toBeInTheDocument();
    // The zap icon should not have the warning color style
    const zapIcon = screen.getByTestId('icon-zap');
    expect(zapIcon).not.toHaveStyle({ color: 'var(--warning, #e6a817)' });
  });

  it('shows toggle as on when max_effort is 1', () => {
    renderControls({ max_effort: 1 });
    openMenu();
    const zapIcon = screen.getByTestId('icon-zap');
    expect(zapIcon).toHaveStyle({ color: 'var(--warning, #e6a817)' });
  });

  it('calls API to enable max effort when clicked while off', async () => {
    renderControls({ max_effort: 0 });
    openMenu();
    fireEvent.click(screen.getByText('Max Effort'));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        `/api/sessions/${sessionId}/max-effort`,
        { maxEffort: true }
      );
    });
  });

  it('calls API to disable max effort when clicked while on', async () => {
    renderControls({ max_effort: 1 });
    openMenu();
    fireEvent.click(screen.getByText('Max Effort'));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        `/api/sessions/${sessionId}/max-effort`,
        { maxEffort: false }
      );
    });
  });
});
