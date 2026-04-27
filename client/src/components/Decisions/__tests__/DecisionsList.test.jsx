// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DecisionsList from '../DecisionsList.jsx';
import { api } from '../../../utils/api.js';

vi.mock('../../../utils/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

// jsdom has no native WebSocket — stub a noop.
class StubWebSocket {
  constructor() {}
  close() {}
  set onmessage(_fn) {}
  set onopen(_fn) {}
}
globalThis.WebSocket = StubWebSocket;

const PIPELINE_ITEM = {
  id: 'ps_pipe1_2',
  kind: 'pipeline_stage',
  project_id: 'p2',
  project_name: 'Beta',
  created_at: new Date().toISOString(),
  pipeline_stage: {
    pipeline_id: 'pipe1',
    pipeline_name: 'My Pipeline',
    stage: 2,
    stage_name: 'QA Design',
    iteration: 1,
    output_path: 'docs/specs/x-qa-plan.md',
    rejection_feedback: null,
  },
};

const PLANNING_ITEM = {
  id: 'pq_q1',
  kind: 'planning',
  project_id: 'p1',
  project_name: 'Alpha',
  created_at: new Date().toISOString(),
  planning: {
    id: 'q1',
    project_id: 'p1',
    project_name: 'Alpha',
    question: 'Should we add foo?',
    escalation_recommendation: 'Yes',
    asked_at: new Date().toISOString(),
    working_files: [],
  },
};

describe('DecisionsList (unified)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows empty state when no items', async () => {
    api.get.mockResolvedValue({ items: [] });
    render(<MemoryRouter><DecisionsList groupByProject /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/No decisions waiting/i)).toBeInTheDocument());
  });

  it('fetches the unified pending endpoint', async () => {
    api.get.mockResolvedValue({ items: [] });
    render(<MemoryRouter><DecisionsList /></MemoryRouter>);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/decisions/pending'));
  });

  it('renders a planning card for kind=planning items', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/decisions/pending')) {
        return Promise.resolve({ items: [PLANNING_ITEM] });
      }
      if (url.endsWith('/chat')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    render(<MemoryRouter><DecisionsList /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Should we add foo?')).toBeInTheDocument());
  });

  it('renders a pipeline approval card for kind=pipeline_stage items', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/decisions/pending')) {
        return Promise.resolve({ items: [PIPELINE_ITEM] });
      }
      if (url.includes('/approval-chat')) return Promise.resolve({ messages: [], stage: { stage: 2, name: 'QA Design' }, pipeline: {} });
      if (url.includes('/output/')) return Promise.resolve({ content: 'stage doc body' });
      return Promise.resolve({});
    });
    render(<MemoryRouter><DecisionsList /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Pipeline approval/i)).toBeInTheDocument());
    expect(screen.getByText(/Stage 2: QA Design/i)).toBeInTheDocument();
  });

  it('groups by project across both kinds', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/decisions/pending')) {
        return Promise.resolve({ items: [PLANNING_ITEM, PIPELINE_ITEM] });
      }
      if (url.endsWith('/chat')) return Promise.resolve([]);
      if (url.includes('/approval-chat')) return Promise.resolve({ messages: [], stage: {}, pipeline: {} });
      if (url.includes('/output/')) return Promise.resolve({ content: '' });
      return Promise.resolve([]);
    });
    render(<MemoryRouter><DecisionsList groupByProject /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Alpha (1)')).toBeInTheDocument());
    expect(screen.getByText('Beta (1)')).toBeInTheDocument();
  });

  it('passes project_id query param when filtering', async () => {
    api.get.mockResolvedValue({ items: [] });
    render(<MemoryRouter><DecisionsList projectId="p1" /></MemoryRouter>);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/decisions/pending?project_id=p1'));
  });
});
