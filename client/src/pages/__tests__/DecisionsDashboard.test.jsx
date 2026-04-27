// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DecisionsDashboard from '../DecisionsDashboard.jsx';
import { api } from '../../utils/api.js';

vi.mock('../../utils/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

describe('DecisionsDashboard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders heading and a project group with items', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/planning/escalations') {
        return Promise.resolve([
          { id: 'q1', project_id: 'p1', project_name: 'Alpha', question: 'Q1', asked_at: new Date().toISOString() },
        ]);
      }
      if (url.endsWith('/chat')) return Promise.resolve([]);
      return Promise.resolve({ count: 1 });
    });
    render(<MemoryRouter><DecisionsDashboard /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('heading', { name: /Decisions/i })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Alpha (1)')).toBeInTheDocument());
  });

  it('shows all-caught-up empty state', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/planning/escalations') return Promise.resolve([]);
      return Promise.resolve({ count: 0 });
    });
    render(<MemoryRouter><DecisionsDashboard /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/No decisions/i)).toBeInTheDocument());
  });
});
