// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DecisionCard from '../DecisionCard.jsx';
import { api } from '../../../utils/api.js';

vi.mock('../../../utils/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));

const sampleItem = {
  id: 'q1',
  question: 'Use Stripe or LemonSqueezy?',
  asking_session_id: 'sess-12345678',
  asked_at: new Date().toISOString(),
  escalation_recommendation: 'Stripe',
  escalation_reason: 'Cost-impact',
  escalation_context: 'No payments doc yet',
  working_files: ['server/payments.js'],
  project_name: 'Storefront',
  project_id: 'p1',
};

describe('DecisionCard', () => {
  beforeEach(() => {
    api.get.mockResolvedValue([]);
    vi.clearAllMocks();
  });

  it('renders question, recommendation, and project name', () => {
    render(<DecisionCard item={sampleItem} onResolved={() => {}} />);
    expect(screen.getByText(/Use Stripe or LemonSqueezy/)).toBeInTheDocument();
    expect(screen.getAllByText(/Stripe/).length).toBeGreaterThan(0);
    expect(screen.getByText('Storefront')).toBeInTheDocument();
  });

  it('loads chat history on mount', async () => {
    api.get.mockResolvedValueOnce([
      { id: 'm1', role: 'user', content: 'Why?' },
      { id: 'm2', role: 'assistant', content: 'Because reasons.' },
    ]);
    render(<DecisionCard item={sampleItem} onResolved={() => {}} />);
    await waitFor(() => expect(screen.getByText('Because reasons.')).toBeInTheDocument());
    expect(api.get).toHaveBeenCalledWith('/api/planning/escalations/q1/chat');
  });

  it('sends a chat message and renders the assistant reply', async () => {
    api.post.mockResolvedValueOnce({
      user: { id: 'u', role: 'user', content: 'hello' },
      assistant: { id: 'a', role: 'assistant', content: 'hi back' },
    });
    render(<DecisionCard item={sampleItem} onResolved={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Ask a question/i), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText('hi back')).toBeInTheDocument());
    expect(api.post).toHaveBeenCalledWith('/api/planning/escalations/q1/chat', { message: 'hello' });
  });

  it('lock-in flow drafts an answer then submits finalize', async () => {
    api.post
      .mockResolvedValueOnce({ answer: 'Stripe.', reasoning_summary: 'Familiarity.' })
      .mockResolvedValueOnce({ status: 'answered' });
    const onResolved = vi.fn();
    render(<DecisionCard item={sampleItem} onResolved={onResolved} />);
    fireEvent.click(screen.getByRole('button', { name: /lock in answer/i }));
    await waitFor(() => expect(screen.getByDisplayValue('Stripe.')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(api.post).toHaveBeenLastCalledWith('/api/planning/escalations/q1/finalize', expect.objectContaining({
      answer: 'Stripe.',
      reasoning_summary: 'Familiarity.',
    }));
  });
});
