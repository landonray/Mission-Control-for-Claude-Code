// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TestRunsPanel from '../TestRunsPanel.jsx';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../../../utils/api', () => ({ api: mockApi }));
vi.mock('../TestRunsPanel.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

// Stub the WebSocket constructor so the panel doesn't try to open a real
// connection during tests. We capture the instance so individual tests can
// drive incoming messages.
let lastWs;
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.onmessage = null;
    this.onclose = null;
    lastWs = this;
  }
  close() { /* no-op */ }
}

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.post.mockReset();
  lastWs = null;
  globalThis.WebSocket = FakeWebSocket;
});

afterEach(() => {
  delete globalThis.WebSocket;
});

function renderPanel() {
  return render(<TestRunsPanel projectId="p-1" />);
}

describe('TestRunsPanel', () => {
  it('shows the empty state when there are no recorded runs', async () => {
    mockApi.get.mockResolvedValue({ runs: [] });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/No test runs recorded yet/)).toBeTruthy();
    });
  });

  it('renders a passed run with counts and no expand affordance', async () => {
    mockApi.get.mockResolvedValue({
      runs: [{
        id: 'r1',
        project_id: 'p-1',
        session_id: 's1',
        command: 'npm test',
        framework: 'vitest',
        status: 'passed',
        total: 12,
        passed: 12,
        failed: 0,
        failures: [],
        created_at: new Date().toISOString(),
      }],
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('npm test')).toBeTruthy();
    });
    expect(screen.getByText('vitest')).toBeTruthy();
    expect(screen.getByText('12 passed')).toBeTruthy();
  });

  it('expands a failed run on click and shows individual failures', async () => {
    mockApi.get.mockResolvedValue({
      runs: [{
        id: 'r2',
        project_id: 'p-1',
        session_id: 's1',
        command: 'pytest -v',
        framework: 'pytest',
        status: 'failed',
        total: 5,
        passed: 4,
        failed: 1,
        failures: [
          { name: 'test_user_login', file: 'tests/test_auth.py', message: 'AssertionError: 401 != 200' },
        ],
        created_at: new Date().toISOString(),
      }],
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('pytest -v')).toBeTruthy();
    });

    // Failure detail should not be visible until the row is clicked
    expect(screen.queryByText('test_user_login')).toBeNull();

    fireEvent.click(screen.getByText('pytest -v'));

    await waitFor(() => {
      expect(screen.getByText('test_user_login')).toBeTruthy();
    });
    expect(screen.getByText('tests/test_auth.py')).toBeTruthy();
    expect(screen.getByText('AssertionError: 401 != 200')).toBeTruthy();
  });

  it('appends a new run when a test_run_started WebSocket message arrives for this project', async () => {
    mockApi.get.mockResolvedValue({ runs: [] });
    renderPanel();

    await waitFor(() => expect(lastWs).toBeTruthy());

    // Simulate a brand-new run starting
    lastWs.onmessage({
      data: JSON.stringify({
        type: 'test_run_started',
        projectId: 'p-1',
        sessionId: 's1',
        run: {
          id: 'r3',
          project_id: 'p-1',
          session_id: 's1',
          command: 'jest --coverage',
          framework: 'jest',
          status: 'parsing',
          created_at: new Date().toISOString(),
        },
      }),
    });

    await waitFor(() => {
      expect(screen.getByText('jest --coverage')).toBeTruthy();
    });
    expect(screen.getByText(/parsing/)).toBeTruthy();
  });

  it('ignores test_run events for a different project', async () => {
    mockApi.get.mockResolvedValue({ runs: [] });
    renderPanel();

    await waitFor(() => expect(lastWs).toBeTruthy());

    lastWs.onmessage({
      data: JSON.stringify({
        type: 'test_run_started',
        projectId: 'p-OTHER',
        sessionId: 's1',
        run: {
          id: 'r4',
          project_id: 'p-OTHER',
          command: 'jest',
          framework: 'jest',
          status: 'parsing',
          created_at: new Date().toISOString(),
        },
      }),
    });

    // Empty state should still show
    await waitFor(() => {
      expect(screen.getByText(/No test runs recorded yet/)).toBeTruthy();
    });
  });
});
