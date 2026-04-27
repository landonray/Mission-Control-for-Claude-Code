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

  it('renders all 7 stages', async () => {
    api.get.mockResolvedValue(mockPipeline);
    renderAt();
    await waitFor(() => expect(screen.getByText(/Stage 1: Spec Refinement/i)).toBeTruthy());
    expect(screen.getByText(/Stage 4: Implementation/i)).toBeTruthy();
    expect(screen.getByText(/Stage 5: QA Execution/i)).toBeTruthy();
    expect(screen.getByText(/Stage 6: Code Review/i)).toBeTruthy();
    expect(screen.getByText(/Stage 7: Fix Cycle/i)).toBeTruthy();
  });

  it('renders chunks for stage 4 and shows escalation banner', async () => {
    const fullPipeline = {
      pipeline: {
        id: 'p2', name: 'Big feature', status: 'paused_for_escalation', current_stage: 7,
        fix_cycle_count: 3, spec_input: 'x', branch_name: 'pipeline-big', project_id: 'proj1',
      },
      outputs: [],
      prompts: {},
      sessions: [],
      chunks: [
        { chunk_index: 1, name: 'first', status: 'completed', complexity: 'small' },
        { chunk_index: 2, name: 'second', status: 'running', complexity: 'medium' },
      ],
      escalations: [
        { id: 'e1', stage: 7, summary: 'Stuck after 3 fix cycles.', detail: 'Latest QA: docs/specs/big-qa-report.md' },
      ],
    };
    api.get.mockResolvedValue(fullPipeline);
    renderAt('/pipelines/p2');
    await waitFor(() => expect(screen.getByText(/Big feature/)).toBeTruthy());
    expect(screen.getByText(/Pipeline needs your attention/i)).toBeTruthy();
    expect(screen.getByText(/Stuck after 3 fix cycles/i)).toBeTruthy();
    expect(screen.getByText(/Chunk 1:/)).toBeTruthy();
    expect(screen.getByText(/Chunk 2:/)).toBeTruthy();
    expect(screen.getByText(/fix cycles of 3 to pass QA/i)).toBeTruthy();
  });

  it('shows the completion banner with PR link when pipeline is completed and pr_url is set', async () => {
    api.get.mockResolvedValue({
      pipeline: {
        id: 'p3', name: 'Done feature', status: 'completed', current_stage: 6,
        fix_cycle_count: 1, spec_input: 'x', branch_name: 'pipeline-done', project_id: 'proj1',
        pr_url: 'https://github.com/example/repo/pull/99',
        pr_creation_error: null,
        completed_at: '2026-04-27T10:00:00Z',
      },
      outputs: [], prompts: {}, sessions: [], chunks: [], escalations: [],
    });
    renderAt('/pipelines/p3');
    await waitFor(() => expect(screen.getByText(/Pipeline complete/i)).toBeTruthy());
    const prLink = screen.getByRole('link', { name: /view pull request/i });
    expect(prLink.getAttribute('href')).toBe('https://github.com/example/repo/pull/99');
    expect(screen.getByText(/Took/i)).toBeTruthy();
  });

  it('shows a Create pull request button when pipeline is completed without a PR', async () => {
    api.get.mockResolvedValue({
      pipeline: {
        id: 'p4', name: 'Done feature', status: 'completed', current_stage: 6,
        fix_cycle_count: 0, spec_input: 'x', branch_name: 'pipeline-done', project_id: 'proj1',
        pr_url: null, pr_creation_error: 'gh not authed',
        completed_at: '2026-04-27T10:00:00Z',
      },
      outputs: [], prompts: {}, sessions: [], chunks: [], escalations: [],
    });
    api.post.mockResolvedValue({ ok: true, url: 'https://github.com/example/repo/pull/101' });
    renderAt('/pipelines/p4');
    await waitFor(() => expect(screen.getByText(/Pipeline complete/i)).toBeTruthy());
    expect(screen.getByText(/gh not authed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /create pull request/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/pipelines/p4/create-pr'));
  });
});
