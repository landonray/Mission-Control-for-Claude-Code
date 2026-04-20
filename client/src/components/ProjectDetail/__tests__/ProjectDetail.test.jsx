// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProjectDetail from '../ProjectDetail.jsx';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('../../../utils/api', () => ({ api: mockApi }));
vi.mock('../ProjectDetail.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

function renderAt(projectId) {
  return render(
    <MemoryRouter initialEntries={[`/projects/${projectId}`]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

const sampleProject = {
  id: 'abc-123',
  name: 'acme-app',
  root_path: '/Users/me/projects/acme-app',
  github_repo: 'me/acme-app',
  deployment_url: null,
  sessions: [
    { id: 'sess-1', name: 'build feature X', status: 'active', branch: 'feat/x', archived: false },
  ],
  servers: [
    { key: 'PORT', role: 'Backend', port: 4001, running: true, pid: 1234, command: 'node', cwd: '/Users/me/projects/acme-app', belongsToProject: true },
    { key: 'VITE_PORT', role: 'Frontend', port: 5173, running: false },
  ],
};

describe('ProjectDetail', () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.get.mockImplementation((url) => {
      if (url === '/api/projects/abc-123') return Promise.resolve({ ...sampleProject });
      if (url === '/api/projects/abc-123/servers') return Promise.resolve({ servers: sampleProject.servers });
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });
    window.confirm = vi.fn(() => true);
    window.alert = vi.fn();
  });

  it('renders project name, GitHub link, and path', async () => {
    renderAt('abc-123');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'acme-app' })).toBeTruthy();
    });
    expect(screen.getByText('me/acme-app')).toBeTruthy();
    expect(screen.getByText('/Users/me/projects/acme-app')).toBeTruthy();
  });

  it('shows Running/Not running server states with kill button for this project', async () => {
    renderAt('abc-123');
    await waitFor(() => {
      expect(screen.getByText(/Running · PID 1234/)).toBeTruthy();
    });
    expect(screen.getByText('Not running')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Kill/ })).toBeTruthy();
  });

  it('calls kill API and refreshes server list when Kill is clicked', async () => {
    mockApi.post.mockResolvedValueOnce({ killed: true, pid: 1234 });
    renderAt('abc-123');
    await waitFor(() => screen.getByRole('button', { name: /Kill/ }));
    fireEvent.click(screen.getByRole('button', { name: /Kill/ }));
    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/projects/abc-123/kill-server', { pid: 1234 });
    });
  });

  it('shows the Host This Project button when not yet deployed', async () => {
    renderAt('abc-123');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Host This Project/i })).toBeTruthy();
    });
  });

  it('shows the deployment URL and hides the Host button when already deployed', async () => {
    mockApi.get.mockImplementation((url) => {
      if (url === '/api/projects/abc-123') {
        return Promise.resolve({ ...sampleProject, deployment_url: 'https://acme.up.railway.app' });
      }
      if (url === '/api/projects/abc-123/servers') return Promise.resolve({ servers: [] });
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });
    renderAt('abc-123');
    await waitFor(() => {
      expect(screen.getByText('https://acme.up.railway.app')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /Host This Project/i })).toBeNull();
  });

  it('surfaces Railway errors when Host deploy fails', async () => {
    mockApi.post.mockRejectedValueOnce(new Error('Railway GitHub App not installed'));
    renderAt('abc-123');
    await waitFor(() => screen.getByRole('button', { name: /Host This Project/i }));
    fireEvent.click(screen.getByRole('button', { name: /Host This Project/i }));
    await waitFor(() => {
      expect(screen.getByText(/GitHub App not installed/i)).toBeTruthy();
    });
  });

  it('lists project sessions', async () => {
    renderAt('abc-123');
    await waitFor(() => {
      expect(screen.getByText('build feature X')).toBeTruthy();
    });
    expect(screen.getByText('feat/x')).toBeTruthy();
  });

  it('shows an error state for unknown projects', async () => {
    mockApi.get.mockImplementationOnce(() => Promise.reject(new Error('Project not found')));
    renderAt('missing');
    await waitFor(() => {
      expect(screen.getByText('Project not found')).toBeTruthy();
    });
  });
});
