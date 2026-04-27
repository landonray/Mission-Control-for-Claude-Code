// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PipelineApprovalCard from '../PipelineApprovalCard.jsx';
import { api } from '../../../utils/api.js';

vi.mock('../../../utils/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const ITEM = {
  id: 'ps_pipe-abc_1',
  kind: 'pipeline_stage',
  project_id: 'p1',
  project_name: 'Alpha',
  created_at: '2026-04-27T10:00:00Z',
  pipeline_stage: {
    pipeline_id: 'pipe-abc',
    pipeline_name: 'Add Foo',
    stage: 1,
    stage_name: 'Spec Refinement',
    iteration: 1,
    output_path: 'docs/specs/foo-refined.md',
    rejection_feedback: null,
  },
};

describe('PipelineApprovalCard', () => {
  beforeEach(() => vi.clearAllMocks());

  function setupSuccessfulFetches() {
    api.get.mockImplementation((url) => {
      if (url.includes('/approval-chat')) {
        return Promise.resolve({ messages: [], stage: { stage: 1, name: 'Spec Refinement' }, pipeline: {} });
      }
      if (url.includes('/output/')) {
        return Promise.resolve({ content: '# Refined Spec\n\nfoo' });
      }
      return Promise.resolve({});
    });
  }

  it('renders the stage header, project, and output path', async () => {
    setupSuccessfulFetches();
    render(<MemoryRouter><PipelineApprovalCard item={ITEM} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Stage 1: Spec Refinement/)).toBeInTheDocument());
    expect(screen.getByText(/Pipeline approval/)).toBeInTheDocument();
    expect(screen.getByText('docs/specs/foo-refined.md')).toBeInTheDocument();
    expect(screen.getByText('Add Foo')).toBeInTheDocument();
  });

  it('shows the previous-feedback panel when rejection_feedback is present', async () => {
    setupSuccessfulFetches();
    const item = { ...ITEM, pipeline_stage: { ...ITEM.pipeline_stage, rejection_feedback: 'Tighten scope.' } };
    render(<MemoryRouter><PipelineApprovalCard item={item} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Tighten scope.')).toBeInTheDocument());
  });

  it('approves the stage when Approve is clicked', async () => {
    setupSuccessfulFetches();
    api.post.mockResolvedValue({ ok: true });
    const onResolved = vi.fn();
    render(<MemoryRouter><PipelineApprovalCard item={ITEM} onResolved={onResolved} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Approve stage/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Approve stage/));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/api/pipelines/pipe-abc/approve');
      expect(onResolved).toHaveBeenCalled();
    });
  });

  it('opens the send-back panel and submits feedback', async () => {
    setupSuccessfulFetches();
    api.post.mockResolvedValue({ ok: true, feedback: 'too short' });
    const onResolved = vi.fn();
    render(<MemoryRouter><PipelineApprovalCard item={ITEM} onResolved={onResolved} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Send back with feedback/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Send back with feedback/));

    const textarea = await screen.findByPlaceholderText(/Be specific\./i);
    fireEvent.change(textarea, { target: { value: 'too short' } });
    fireEvent.click(screen.getByText(/^Send back$/));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/api/pipelines/pipe-abc/send-back', { feedback: 'too short' });
      expect(onResolved).toHaveBeenCalled();
    });
  });

  it('sends a chat message and appends both user and assistant replies', async () => {
    setupSuccessfulFetches();
    api.post.mockResolvedValue({
      user: { id: 'u1', role: 'user', content: 'hi' },
      assistant: { id: 'a1', role: 'assistant', content: 'looks good' },
    });
    render(<MemoryRouter><PipelineApprovalCard item={ITEM} /></MemoryRouter>);
    const input = await screen.findByPlaceholderText(/Ask about this stage/);
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(screen.getByText('looks good')).toBeInTheDocument());
    expect(api.post).toHaveBeenCalledWith('/api/pipelines/pipe-abc/approval-chat', { message: 'hi' });
  });
});
