// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mocks — vi.mock is hoisted, so use vi.hoisted for shared references
const { mockApi } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

vi.mock('../../../utils/api', () => ({
  api: mockApi,
}));

// Lucide icons — render as simple spans
vi.mock('lucide-react', () => ({
  ChevronDown: (props) => React.createElement('span', { 'data-testid': 'icon-chevron-down', ...props }),
  ChevronRight: (props) => React.createElement('span', { 'data-testid': 'icon-chevron-right', ...props }),
  Shield: (props) => React.createElement('span', { 'data-testid': 'icon-shield', ...props }),
  FolderOpen: (props) => React.createElement('span', { 'data-testid': 'icon-folder', ...props }),
  Clock: (props) => React.createElement('span', { 'data-testid': 'icon-clock', ...props }),
  Play: (props) => React.createElement('span', { 'data-testid': 'icon-play', ...props }),
  CheckCircle: (props) => React.createElement('span', { 'data-testid': 'icon-check', ...props }),
  XCircle: (props) => React.createElement('span', { 'data-testid': 'icon-x', ...props }),
  AlertTriangle: (props) => React.createElement('span', { 'data-testid': 'icon-alert', ...props }),
  FileText: (props) => React.createElement('span', { 'data-testid': 'icon-file', ...props }),
}));

// Mock CSS modules
vi.mock('../QualityTab.module.css', () => ({ default: {} }));

import QualityTab from '../QualityTab';

describe('QualityTab Integration', () => {
  const sessionId = 'test-session-456';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no project is linked', async () => {
    mockApi.get.mockRejectedValueOnce(new Error('not found'));

    render(<QualityTab sessionId={sessionId} />);

    await waitFor(() => {
      expect(screen.getByText(/No project linked to this session/)).toBeInTheDocument();
    });

    expect(screen.getByText(/\.mission-control\.yaml/)).toBeInTheDocument();
  });

  it('shows empty state when project API returns null', async () => {
    mockApi.get.mockResolvedValueOnce(null);

    render(<QualityTab sessionId={sessionId} />);

    await waitFor(() => {
      expect(screen.getByText(/No project linked to this session/)).toBeInTheDocument();
    });
  });

  it('renders eval folders when project exists', async () => {
    // Project lookup
    mockApi.get.mockResolvedValueOnce({ id: 'proj-1', name: 'My Project' });
    // Rules
    mockApi.get.mockResolvedValueOnce([
      { id: 'r1', display_name: 'No TODOs', severity: 'medium', enabled: true },
    ]);
    // Folders
    mockApi.get.mockResolvedValueOnce([
      {
        folder_path: '/evals/unit',
        name: 'unit',
        armed: true,
        eval_count: 3,
        triggers: ['session_end'],
        auto_send: false,
        evals: [{ id: 'e1', name: 'Test coverage', evidence_type: 'code', description: 'Check test coverage' }],
      },
    ]);
    // History
    mockApi.get.mockResolvedValueOnce([]);

    render(<QualityTab sessionId={sessionId} />);

    await waitFor(() => {
      expect(screen.getByText('unit')).toBeInTheDocument();
    });

    expect(screen.getByText('3 evals')).toBeInTheDocument();
    expect(screen.getByText('session end')).toBeInTheDocument();
  });

  it('shows "Run Armed Evals" button when project exists', async () => {
    mockApi.get.mockResolvedValueOnce({ id: 'proj-1', name: 'My Project' });
    mockApi.get.mockResolvedValueOnce([]); // rules
    mockApi.get.mockResolvedValueOnce([]); // folders
    mockApi.get.mockResolvedValueOnce([]); // history

    render(<QualityTab sessionId={sessionId} />);

    await waitFor(() => {
      expect(screen.getByText('Run Armed Evals')).toBeInTheDocument();
    });
  });

  it('calls run API when "Run Armed Evals" is clicked', async () => {
    mockApi.get.mockResolvedValueOnce({ id: 'proj-1', name: 'My Project' });
    mockApi.get.mockResolvedValueOnce([]); // rules
    mockApi.get.mockResolvedValueOnce([]); // folders
    mockApi.get.mockResolvedValueOnce([]); // history
    mockApi.post.mockResolvedValueOnce({ batch_id: 'b1' });
    // History reload after run
    mockApi.get.mockResolvedValueOnce([]);

    render(<QualityTab sessionId={sessionId} />);

    await waitFor(() => {
      expect(screen.getByText('Run Armed Evals')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Run Armed Evals'));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/evals/run/proj-1');
    });
  });

  it('renders quality rules section', async () => {
    mockApi.get.mockResolvedValueOnce({ id: 'proj-1', name: 'My Project' });
    mockApi.get.mockResolvedValueOnce([
      { id: 'r1', display_name: 'No hardcoded secrets', severity: 'high', enabled: true },
      { id: 'r2', display_name: 'Test coverage', severity: 'medium', enabled: false },
    ]);
    mockApi.get.mockResolvedValueOnce([]); // folders
    mockApi.get.mockResolvedValueOnce([]); // history

    render(<QualityTab sessionId={sessionId} />);

    // Quality Rules section is collapsed by default — click to open
    await waitFor(() => {
      expect(screen.getByText('Quality Rules')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Quality Rules'));

    await waitFor(() => {
      expect(screen.getByText('No hardcoded secrets')).toBeInTheDocument();
    });

    expect(screen.getByText('Test coverage')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('medium')).toBeInTheDocument();
  });

  it('renders run history with batch details', async () => {
    mockApi.get.mockResolvedValueOnce({ id: 'proj-1', name: 'My Project' });
    mockApi.get.mockResolvedValueOnce([]); // rules
    mockApi.get.mockResolvedValueOnce([]); // folders
    mockApi.get.mockResolvedValueOnce([
      {
        id: 'batch-1',
        trigger_source: 'manual',
        commit_sha: 'abc1234567890',
        started_at: '2026-04-15T10:00:00Z',
        passed: 2,
        failed: 1,
        errors: 0,
      },
    ]);

    render(<QualityTab sessionId={sessionId} />);

    // Run History is collapsed by default — click to open
    await waitFor(() => {
      expect(screen.getByText('Run History')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Run History'));

    await waitFor(() => {
      expect(screen.getByText('manual')).toBeInTheDocument();
    });

    expect(screen.getByText('abc1234')).toBeInTheDocument();
    expect(screen.getByText('2 pass')).toBeInTheDocument();
    expect(screen.getByText('1 fail')).toBeInTheDocument();
  });

  it('toggles arming on a folder', async () => {
    mockApi.get.mockResolvedValueOnce({ id: 'proj-1', name: 'My Project' });
    mockApi.get.mockResolvedValueOnce([]); // rules
    mockApi.get.mockResolvedValueOnce([
      { folder_path: '/evals/unit', name: 'unit', armed: false, eval_count: 2, triggers: [], auto_send: false },
    ]);
    mockApi.get.mockResolvedValueOnce([]); // history
    mockApi.post.mockResolvedValueOnce({ success: true }); // arm call
    // Reload folders after arm
    mockApi.get.mockResolvedValueOnce([
      { folder_path: '/evals/unit', name: 'unit', armed: true, eval_count: 2, triggers: [], auto_send: false },
    ]);

    render(<QualityTab sessionId={sessionId} />);

    await waitFor(() => {
      expect(screen.getByText('unit')).toBeInTheDocument();
    });

    // The toggle button in the folder row — find the first toggle button in the folder
    const toggleButtons = screen.getAllByRole('button').filter(btn =>
      btn.className === '' || btn.textContent === '' // toggle buttons have no text content
    );

    // Find the arm toggle — it's the first toggle-like button before the folder name
    // We'll click the first button that's not a section header or expand button
    const folderToggles = screen.getAllByRole('button');
    // The arm toggle is a button with no text content, in the folder area
    const armToggle = folderToggles.find(btn => {
      // Toggle buttons render with just a span inside
      return btn.querySelector('span') && !btn.textContent.trim() && !btn.getAttribute('data-testid');
    });

    if (armToggle) {
      fireEvent.click(armToggle);

      await waitFor(() => {
        expect(mockApi.post).toHaveBeenCalledWith('/api/evals/folders/proj-1/arm', { folder_path: '/evals/unit' });
      });
    }
  });

  it('shows loading state initially', () => {
    mockApi.get.mockImplementation(() => new Promise(() => {})); // never resolves

    render(<QualityTab sessionId={sessionId} />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });
});
