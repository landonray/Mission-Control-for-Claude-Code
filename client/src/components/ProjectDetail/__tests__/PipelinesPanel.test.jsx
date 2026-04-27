// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PipelinesPanel from '../PipelinesPanel';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../../../utils/api', () => ({ api: mockApi }));
vi.mock('../PipelinesPanel.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));
vi.mock('../NewPipelineDialog', () => ({
  default: () => <div data-testid="new-pipeline-dialog" />,
}));

function renderWithRouter(ui) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('PipelinesPanel', () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
  });

  it('renders an empty state when no pipelines exist', async () => {
    mockApi.get.mockResolvedValue({ pipelines: [] });
    renderWithRouter(<PipelinesPanel projectId="proj1" />);
    await waitFor(() => expect(screen.getByText(/no pipelines yet/i)).toBeTruthy());
  });

  it('renders pipeline rows when pipelines exist', async () => {
    mockApi.get.mockResolvedValue({
      pipelines: [
        { id: 'p1', name: 'Add pagination', status: 'running', current_stage: 2, created_at: '2026-04-26T00:00:00Z' },
        { id: 'p2', name: 'Refactor auth', status: 'completed', current_stage: 3, created_at: '2026-04-25T00:00:00Z' },
      ],
    });
    renderWithRouter(<PipelinesPanel projectId="proj1" />);
    await waitFor(() => {
      expect(screen.getByText('Add pagination')).toBeTruthy();
      expect(screen.getByText('Refactor auth')).toBeTruthy();
    });
  });

  it('shows a New Pipeline button', async () => {
    mockApi.get.mockResolvedValue({ pipelines: [] });
    renderWithRouter(<PipelinesPanel projectId="proj1" />);
    await waitFor(() => expect(screen.getByText(/new pipeline/i)).toBeTruthy());
  });
});
