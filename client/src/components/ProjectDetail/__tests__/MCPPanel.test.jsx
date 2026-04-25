// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MCPPanel from '../MCPPanel.jsx';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../../../utils/api', () => ({ api: mockApi }));
vi.mock('../MCPPanel.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

describe('MCPPanel', () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.get.mockImplementation((url) => {
      if (url === '/api/mcp-tokens/abc-123') return Promise.resolve([]);
      if (url.startsWith('/api/planning/questions')) return Promise.resolve([]);
      if (url === '/api/planning/decisions/abc-123') return Promise.resolve({ exists: false, entries: [], path: null });
      if (url.startsWith('/api/mcp-tokens/abc-123/connect-snippet')) return Promise.resolve({
        project: { id: 'abc-123', name: 'acme' },
        mcpUrl: 'http://localhost:3001/mcp',
        snippet: { mcpServers: { 'mission-control': { type: 'http', url: 'http://localhost:3001/mcp', headers: { Authorization: 'Bearer mc_test' } } } },
        instructions: 'Paste this',
      });
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });
    window.confirm = vi.fn(() => true);
  });

  it('shows empty states when no tokens / questions / decisions exist', async () => {
    render(<MCPPanel projectId="abc-123" projectName="acme" />);
    await waitFor(() => {
      expect(screen.getByText(/Generate token/)).toBeTruthy();
    });
    expect(screen.getByText(/No tokens yet/)).toBeTruthy();
    expect(screen.getByText(/No planning questions yet/)).toBeTruthy();
    expect(screen.getByText(/No decisions log yet/)).toBeTruthy();
  });

  it('generates a token, fetches the connect snippet, and shows it once', async () => {
    mockApi.post.mockResolvedValueOnce({
      id: 't1', project_id: 'abc-123', token: 'mc_test_token', name: 'Default',
    });
    // Subsequent listTokens reload
    mockApi.get.mockImplementationOnce((url) => Promise.resolve([])) // initial
      .mockImplementationOnce((url) => Promise.resolve([])) // questions
      .mockImplementationOnce((url) => Promise.resolve({ exists: false, entries: [], path: null })) // decisions
      .mockImplementationOnce((url) => Promise.resolve({   // connect-snippet after create
        project: { id: 'abc-123', name: 'acme' },
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
      }))
      .mockImplementationOnce(() => Promise.resolve([{
        id: 't1', project_id: 'abc-123', name: 'Default',
        active: 1, created_at: '2026-04-24T12:00:00Z', last_used_at: null,
      }])); // refreshed tokens list

    render(<MCPPanel projectId="abc-123" projectName="acme" />);

    await waitFor(() => screen.getByRole('button', { name: /Generate token/ }));
    fireEvent.click(screen.getByRole('button', { name: /Generate token/ }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/mcp-tokens/abc-123', { name: 'Default' });
    });
    await waitFor(() => {
      expect(screen.getByText(/Token created/)).toBeTruthy();
    });
    // The snippet shows the new token in JSON
    expect(screen.getByText(/mc_test_token/)).toBeTruthy();
  });

  it('renders existing planning questions with status badge', async () => {
    mockApi.get.mockReset();
    mockApi.get.mockImplementation((url) => {
      if (url === '/api/mcp-tokens/abc-123') return Promise.resolve([]);
      if (url.startsWith('/api/planning/questions')) return Promise.resolve([
        { id: 'q1', question: 'Cursor or offset pagination?', answer: 'Cursor.', status: 'answered', asked_at: '2026-04-24T10:00:00Z' },
        { id: 'q2', question: 'How to model tenants?', answer: null, status: 'pending', asked_at: '2026-04-24T11:00:00Z' },
      ]);
      if (url === '/api/planning/decisions/abc-123') return Promise.resolve({ exists: true, entries: [{ summary: 'a' }, { summary: 'b' }], path: '/p/docs/decisions.md' });
      return Promise.reject(new Error('unexpected ' + url));
    });

    render(<MCPPanel projectId="abc-123" projectName="acme" />);

    await waitFor(() => {
      expect(screen.getByText('Cursor or offset pagination?')).toBeTruthy();
    });
    expect(screen.getByText('How to model tenants?')).toBeTruthy();
    expect(screen.getByText('answered')).toBeTruthy();
    expect(screen.getByText('pending')).toBeTruthy();
    expect(screen.getByText(/2 entries logged/)).toBeTruthy();
  });
});
