// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DecisionsNeeded from '../DecisionsNeeded.jsx';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('../../../utils/api', () => ({ api: mockApi }));
vi.mock('../DecisionsNeeded.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

describe('DecisionsNeeded', () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
  });

  it('shows empty state when no escalations', async () => {
    mockApi.get.mockResolvedValueOnce([]);
    render(<DecisionsNeeded projectId="p1" onChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/no decisions waiting/i)).toBeInTheDocument();
    });
  });

  it('renders an escalation with question, recommendation, reason', async () => {
    mockApi.get.mockResolvedValueOnce([{
      id: 'pq-1',
      asking_session_id: 'imp-1',
      question: 'Should we drop SQLite?',
      escalation_recommendation: 'Keep it for one release.',
      escalation_reason: 'External stakeholders.',
      escalation_context: 'Two customers still on it.',
      asked_at: '2026-04-25T00:00:00Z',
      working_files: ['a.js'],
    }]);
    render(<DecisionsNeeded projectId="p1" onChange={() => {}} />);
    expect(await screen.findByText(/Should we drop SQLite/)).toBeInTheDocument();
    expect(screen.getByText(/Keep it for one release/)).toBeInTheDocument();
    expect(screen.getByText(/External stakeholders/)).toBeInTheDocument();
  });

  it('calls onChange with the count when items load', async () => {
    const onChange = vi.fn();
    mockApi.get.mockResolvedValueOnce([
      { id: 'pq-1', question: 'Q1', escalation_recommendation: 'R', escalation_reason: 'X', escalation_context: '', asked_at: '2026-04-25T00:00:00Z', working_files: [] },
      { id: 'pq-2', question: 'Q2', escalation_recommendation: 'R', escalation_reason: 'X', escalation_context: '', asked_at: '2026-04-25T00:00:00Z', working_files: [] },
    ]);
    render(<DecisionsNeeded projectId="p1" onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(2));
  });

  it('submits an answer with addToContextDoc choice', async () => {
    mockApi.get.mockResolvedValueOnce([{
      id: 'pq-1', question: 'Q', escalation_recommendation: 'R',
      escalation_reason: 'Strategic', escalation_context: '',
      asked_at: '2026-04-25T00:00:00Z', working_files: [],
    }]);
    mockApi.post.mockResolvedValueOnce({ status: 'answered' });
    mockApi.get.mockResolvedValueOnce([]); // refetch after submit

    render(<DecisionsNeeded projectId="p1" onChange={() => {}} />);
    await screen.findByText('Q');

    fireEvent.change(screen.getByLabelText(/your answer/i), { target: { value: 'Do it.' } });
    fireEvent.change(screen.getByLabelText(/add to/i), { target: { value: 'PRODUCT.md' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/planning/escalations/pq-1/answer',
        { answer: 'Do it.', addToContextDoc: 'PRODUCT.md' }
      );
    });
  });

  it('dismisses an escalation when confirmed', async () => {
    mockApi.get.mockResolvedValueOnce([{
      id: 'pq-1', question: 'Q', escalation_recommendation: 'R',
      escalation_reason: 'X', escalation_context: '', asked_at: '2026-04-25T00:00:00Z', working_files: [],
    }]);
    mockApi.post.mockResolvedValueOnce({ status: 'dismissed' });
    mockApi.get.mockResolvedValueOnce([]);

    window.confirm = vi.fn(() => true);

    render(<DecisionsNeeded projectId="p1" onChange={() => {}} />);
    await screen.findByText('Q');
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/api/planning/escalations/pq-1/dismiss');
    });
  });
});
