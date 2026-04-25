// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MCPPanel from '../MCPPanel.jsx';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../../../utils/api', () => ({ api: mockApi }));
vi.mock('../MCPPanel.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

function renderPanel() {
  return render(
    <MemoryRouter>
      <MCPPanel projectId="abc-123" />
    </MemoryRouter>
  );
}

describe('MCPPanel — per-project planning activity', () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
  });

  it('shows empty states when there are no questions and no decisions log', async () => {
    mockApi.get.mockImplementation((url) => {
      if (url.startsWith('/api/planning/questions')) return Promise.resolve([]);
      if (url === '/api/planning/decisions/abc-123') {
        return Promise.resolve({ exists: false, entries: [], path: null });
      }
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(/No planning questions yet/)).toBeTruthy();
    });
    expect(screen.getByText(/No decisions log yet/)).toBeTruthy();
    expect(screen.getByText(/Settings → Mission Control MCP/)).toBeTruthy();
  });

  it('renders existing planning questions with status badges', async () => {
    mockApi.get.mockImplementation((url) => {
      if (url.startsWith('/api/planning/questions')) {
        return Promise.resolve([
          { id: 'q1', question: 'Cursor or offset pagination?', answer: 'Cursor.', status: 'answered', asked_at: '2026-04-24T10:00:00Z' },
          { id: 'q2', question: 'How to model tenants?', answer: null, status: 'pending', asked_at: '2026-04-24T11:00:00Z' },
        ]);
      }
      if (url === '/api/planning/decisions/abc-123') {
        return Promise.resolve({
          exists: true,
          entries: [{ summary: 'a' }, { summary: 'b' }],
          path: '/p/docs/decisions.md',
        });
      }
      return Promise.reject(new Error('unexpected ' + url));
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('Cursor or offset pagination?')).toBeTruthy();
    });
    expect(screen.getByText('How to model tenants?')).toBeTruthy();
    expect(screen.getByText('answered')).toBeTruthy();
    expect(screen.getByText('pending')).toBeTruthy();
    expect(screen.getByText(/2 entries logged/)).toBeTruthy();
  });
});
