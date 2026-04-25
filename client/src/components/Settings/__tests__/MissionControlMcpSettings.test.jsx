// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MissionControlMcpSettings from '../MissionControlMcpSettings.jsx';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../../../utils/api', () => ({ api: mockApi }));
vi.mock('../MissionControlMcpSettings.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

describe('MissionControlMcpSettings — global token UI', () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    window.confirm = vi.fn(() => true);
  });

  it('shows empty state when there are no tokens', async () => {
    mockApi.get.mockImplementation((url) => {
      if (url === '/api/mcp-tokens') return Promise.resolve([]);
      return Promise.reject(new Error('unexpected url: ' + url));
    });

    render(<MissionControlMcpSettings />);

    await waitFor(() => {
      expect(screen.getByText(/No tokens yet/)).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: /Generate token/ })).toBeTruthy();
  });

  it('generates a token, fetches the snippet, and reveals it once', async () => {
    // initial list -> empty
    mockApi.get.mockImplementationOnce(() => Promise.resolve([]));
    // POST creates token
    mockApi.post.mockResolvedValueOnce({
      id: 't1',
      token: 'mc_test_token',
      name: 'Default',
    });
    // connect-snippet
    mockApi.get.mockImplementationOnce(() => Promise.resolve({
      mcpUrl: 'http://localhost:3001/mcp',
      snippet: {
        mcpServers: {
          'mission-control': {
            type: 'http',
            url: 'http://localhost:3001/mcp',
            headers: { Authorization: 'Bearer mc_test_token' },
          },
        },
      },
      instructions: 'Paste this somewhere',
    }));
    // reload tokens list shows the new token
    mockApi.get.mockImplementationOnce(() => Promise.resolve([
      {
        id: 't1', name: 'Default',
        active: 1, created_at: '2026-04-25T10:00:00Z', last_used_at: null,
      },
    ]));

    render(<MissionControlMcpSettings />);

    await waitFor(() => screen.getByRole('button', { name: /Generate token/ }));
    fireEvent.click(screen.getByRole('button', { name: /Generate token/ }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/mcp-tokens', { name: 'Default' });
    });
    await waitFor(() => {
      expect(screen.getByText(/Token created/)).toBeTruthy();
    });
    expect(screen.getByText(/mc_test_token/)).toBeTruthy();
    expect(screen.getByText(/Use the snippet below/)).toBeTruthy();
  });

  it('shows setup instructions for Claude Code and Claude Desktop', async () => {
    mockApi.get.mockImplementation((url) => {
      if (url === '/api/mcp-tokens') return Promise.resolve([]);
      return Promise.reject(new Error('unexpected url: ' + url));
    });

    render(<MissionControlMcpSettings />);

    await waitFor(() => screen.getByText(/How to connect/));
    expect(screen.getByText(/Claude Code \(terminal\)/)).toBeTruthy();
    expect(screen.getByText(/Claude Desktop \(Mac \/ Windows app\)/)).toBeTruthy();
    // mac config path appears at least once
    expect(screen.getAllByText(/claude_desktop_config\.json/).length).toBeGreaterThan(0);
    // claude code config file
    expect(screen.getByText(/~\/\.claude\.json/)).toBeTruthy();
  });

  it('lists existing tokens with active/revoked status', async () => {
    mockApi.get.mockImplementation((url) => {
      if (url === '/api/mcp-tokens') {
        return Promise.resolve([
          { id: 't1', name: 'Default', active: 1, created_at: '2026-04-25T10:00:00Z', last_used_at: null },
          { id: 't2', name: 'Old', active: 0, created_at: '2026-03-01T10:00:00Z', last_used_at: null, revoked_at: '2026-03-15T10:00:00Z' },
        ]);
      }
      return Promise.reject(new Error('unexpected url'));
    });

    render(<MissionControlMcpSettings />);

    await waitFor(() => {
      expect(screen.getByText('Default')).toBeTruthy();
    });
    expect(screen.getByText('Old')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('revoked')).toBeTruthy();
  });
});
