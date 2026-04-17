// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewSessionModal from '../NewSessionModal.jsx';

const { mockApi, mockNavigate, mockLoadSessions } = vi.hoisted(() => ({
  mockApi: {
    get: vi.fn((url) => {
      if (url === '/api/models') {
        return Promise.resolve({
          models: [
            { value: 'claude-opus-4-7', label: 'Opus' },
            { value: 'claude-sonnet-4-6', label: 'Sonnet' },
          ],
          defaultModel: 'claude-opus-4-7',
          efforts: ['high', 'xhigh', 'max'],
          defaultEffort: 'high',
          xhighSupportedModels: ['claude-opus-4-7'],
        });
      }
      if (url === '/api/projects') return Promise.resolve([]);
      return Promise.resolve({});
    }),
    post: vi.fn(() => Promise.resolve({ id: 'fake-id' })),
  },
  mockNavigate: vi.fn(),
  mockLoadSessions: vi.fn(),
}));

vi.mock('../../../utils/api', () => ({ api: mockApi }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));
vi.mock('../../../context/AppContext', () => ({
  useApp: () => ({ loadSessions: mockLoadSessions, generalSettings: null }),
}));
vi.mock('../NewSessionModal.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

describe('NewSessionModal effort picker', () => {
  beforeEach(() => {
    mockApi.get.mockClear();
    mockApi.post.mockClear();
  });

  it('shows an Effort picker with High / xHigh / Max', async () => {
    render(<NewSessionModal onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/Effort/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /^High$/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: /^xHigh$/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: /^Max$/ })).toBeTruthy();
    });
  });

  it('auto-downgrades effort from xHigh to High when switching to a non-supporting model', async () => {
    render(<NewSessionModal onClose={() => {}} />);
    await waitFor(() => screen.getByRole('button', { name: /^xHigh$/ }));

    fireEvent.click(screen.getByRole('button', { name: /^xHigh$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Sonnet$/ }));

    await waitFor(() => {
      expect(screen.getByText(/Effort lowered to High/i)).toBeTruthy();
    });
  });
});
