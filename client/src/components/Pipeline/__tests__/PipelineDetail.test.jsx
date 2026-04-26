// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PipelineDetail from '../PipelineDetail';

vi.mock('../../../utils/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

import { api } from '../../../utils/api';

function renderAt(path = '/pipelines/p1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/pipelines/:id" element={<PipelineDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

const mockPipeline = {
  pipeline: {
    id: 'p1', name: 'Add pagination', status: 'paused_for_approval', current_stage: 1,
    spec_input: 'spec', branch_name: 'pipeline-add-pagination', project_id: 'proj1',
  },
  outputs: [
    { id: 1, stage: 1, iteration: 1, output_path: 'docs/specs/add-pagination-refined.md', status: 'completed' },
  ],
  prompts: { '1': 'Stage 1 prompt', '2': 'Stage 2 prompt', '3': 'Stage 3 prompt' },
  sessions: [{ id: 's1', session_type: 'spec_refinement', status: 'completed', pipeline_stage: 1 }],
};

describe('PipelineDetail', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
    api.put.mockReset();
  });

  it('renders the pipeline name and stage list', async () => {
    api.get.mockImplementation((url) => {
      if (url.endsWith('/p1')) return Promise.resolve(mockPipeline);
      if (url.includes('/output/')) return Promise.resolve({ content: '# refined spec\nbody' });
      return Promise.resolve({});
    });
    renderAt();
    await waitFor(() => expect(screen.getByText('Add pagination')).toBeTruthy());
    expect(screen.getByText(/Stage 1: Spec Refinement/i)).toBeTruthy();
    expect(screen.getByText(/Stage 2: QA Design/i)).toBeTruthy();
    expect(screen.getByText(/Stage 3: Implementation Planning/i)).toBeTruthy();
  });

  it('shows approve and reject buttons on the current paused stage', async () => {
    api.get.mockResolvedValue(mockPipeline);
    renderAt();
    await waitFor(() => expect(screen.getByRole('button', { name: /^approve$/i })).toBeTruthy());
    expect(screen.getByRole('button', { name: /^reject$/i })).toBeTruthy();
  });

  it('approves the current stage', async () => {
    api.get.mockResolvedValue(mockPipeline);
    api.post.mockResolvedValue({ ok: true });
    renderAt();
    await waitFor(() => expect(screen.getByRole('button', { name: /^approve$/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/pipelines/p1/approve'));
  });

  it('rejects the current stage with feedback', async () => {
    api.get.mockResolvedValue(mockPipeline);
    api.post.mockResolvedValue({ ok: true });
    renderAt();
    await waitFor(() => expect(screen.getByRole('button', { name: /^reject$/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    const textarea = screen.getByPlaceholderText(/why are you rejecting/i);
    fireEvent.change(textarea, { target: { value: 'too vague' } });
    fireEvent.click(screen.getByRole('button', { name: /submit rejection/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/pipelines/p1/reject', { feedback: 'too vague' }));
  });
});
