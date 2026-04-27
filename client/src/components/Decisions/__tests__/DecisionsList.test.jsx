// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import DecisionsList from '../DecisionsList.jsx';
import { api } from '../../../utils/api.js';

vi.mock('../../../utils/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

describe('DecisionsList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows empty state when no escalations', async () => {
    api.get.mockResolvedValue([]);
    render(<DecisionsList groupByProject />);
    await waitFor(() => expect(screen.getByText(/No decisions waiting/i)).toBeInTheDocument());
  });

  it('groups by project when groupByProject=true', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/planning/escalations') {
        return Promise.resolve([
          { id: 'q1', project_id: 'p1', project_name: 'Alpha', question: 'Q1', asked_at: new Date().toISOString() },
          { id: 'q2', project_id: 'p1', project_name: 'Alpha', question: 'Q2', asked_at: new Date().toISOString() },
          { id: 'q3', project_id: 'p2', project_name: 'Beta', question: 'Q3', asked_at: new Date().toISOString() },
        ]);
      }
      // Each DecisionCard fetches its own chat history; return empty array.
      if (url.endsWith('/chat')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    render(<DecisionsList groupByProject />);
    await waitFor(() => expect(screen.getByText('Alpha (2)')).toBeInTheDocument());
    expect(screen.getByText('Beta (1)')).toBeInTheDocument();
  });

  it('filters by projectId when given', async () => {
    api.get.mockImplementation((url) => {
      if (url.endsWith('/chat')) return Promise.resolve([]);
      return Promise.resolve([{ id: 'q1', project_id: 'p1', question: 'Q1', asked_at: new Date().toISOString() }]);
    });
    render(<DecisionsList projectId="p1" />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/planning/escalations?project_id=p1'));
  });
});
