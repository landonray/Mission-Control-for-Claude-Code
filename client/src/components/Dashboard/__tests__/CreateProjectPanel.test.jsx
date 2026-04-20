// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CreateProjectPanel from '../CreateProjectPanel.jsx';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    post: vi.fn(() => Promise.resolve({ sessionId: 'sess-123' })),
  },
}));

vi.mock('../../../utils/api', () => ({ api: mockApi }));
vi.mock('../../../context/AppContext', () => ({
  useApp: () => ({ generalSettings: { setup_repo: 'owner/setup' } }),
}));
vi.mock('../CreateProjectPanel.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

describe('CreateProjectPanel', () => {
  beforeEach(() => {
    mockApi.post.mockClear();
    mockApi.post.mockImplementation(() => Promise.resolve({ sessionId: 'sess-123' }));
  });

  it('shows mode toggle with Create New and Clone from GitHub options', () => {
    render(<CreateProjectPanel onBack={() => {}} onCreated={() => {}} model="opus" />);
    expect(screen.getByRole('button', { name: /Create New/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Clone from GitHub/i })).toBeTruthy();
  });

  it('defaults to Create mode and shows Project Name input', () => {
    render(<CreateProjectPanel onBack={() => {}} onCreated={() => {}} model="opus" />);
    expect(screen.getByPlaceholderText('my-new-project')).toBeTruthy();
    expect(screen.queryByPlaceholderText(/github.com\/owner\/repo/i)).toBeNull();
  });

  it('switches to Clone mode and shows GitHub URL input', () => {
    render(<CreateProjectPanel onBack={() => {}} onCreated={() => {}} model="opus" />);
    fireEvent.click(screen.getByRole('button', { name: /Clone from GitHub/i }));
    expect(screen.getByPlaceholderText(/github.com\/owner\/repo/i)).toBeTruthy();
    expect(screen.queryByPlaceholderText('my-new-project')).toBeNull();
  });

  it('posts to /api/projects/clone with URL on submit', async () => {
    const onCreated = vi.fn();
    render(<CreateProjectPanel onBack={() => {}} onCreated={onCreated} model="opus" />);

    fireEvent.click(screen.getByRole('button', { name: /Clone from GitHub/i }));
    fireEvent.change(screen.getByPlaceholderText(/github.com\/owner\/repo/i), {
      target: { value: 'https://github.com/landonray/command-center' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Clone Project/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/projects/clone', {
        url: 'https://github.com/landonray/command-center',
        model: 'opus',
        autoSetup: true,
      });
      expect(onCreated).toHaveBeenCalledWith('sess-123');
    });
  });

  it('shows error when submitting clone with empty URL', () => {
    render(<CreateProjectPanel onBack={() => {}} onCreated={() => {}} model="opus" />);
    fireEvent.click(screen.getByRole('button', { name: /Clone from GitHub/i }));
    fireEvent.click(screen.getByRole('button', { name: /Clone Project/i }));
    expect(screen.getByText(/GitHub URL is required/i)).toBeTruthy();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('surfaces server errors from clone endpoint', async () => {
    mockApi.post.mockImplementation(() => Promise.reject(new Error('Clone failed: repo not found')));
    render(<CreateProjectPanel onBack={() => {}} onCreated={() => {}} model="opus" />);

    fireEvent.click(screen.getByRole('button', { name: /Clone from GitHub/i }));
    fireEvent.change(screen.getByPlaceholderText(/github.com\/owner\/repo/i), {
      target: { value: 'https://github.com/owner/repo' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Clone Project/i }));

    await waitFor(() => {
      expect(screen.getByText(/Clone failed: repo not found/i)).toBeTruthy();
    });
  });

  it('allows unchecking auto-setup in clone mode', async () => {
    render(<CreateProjectPanel onBack={() => {}} onCreated={() => {}} model="opus" />);

    fireEvent.click(screen.getByRole('button', { name: /Clone from GitHub/i }));
    fireEvent.change(screen.getByPlaceholderText(/github.com\/owner\/repo/i), {
      target: { value: 'owner/repo' },
    });
    const checkbox = screen.getByLabelText(/Auto-setup after clone/i);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: /Clone Project/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/projects/clone', {
        url: 'owner/repo',
        model: 'opus',
        autoSetup: false,
      });
    });
  });
});
