// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// Lucide icons — render as simple spans
vi.mock('lucide-react', () => ({
  ChevronLeft: (props) => React.createElement('span', { 'data-testid': 'icon-chevron-left', ...props }),
  Plus: (props) => React.createElement('span', { 'data-testid': 'icon-plus', ...props }),
  Trash2: (props) => React.createElement('span', { 'data-testid': 'icon-trash', ...props }),
}));

// Mock CSS modules
vi.mock('../components/Quality/CreateEvalForm.module.css', () => ({ default: {} }));

import CreateEvalForm from '../components/Quality/CreateEvalForm';

const defaultProps = {
  folderPath: '/evals/unit',
  folderName: 'unit',
  onClose: vi.fn(),
  onCreate: vi.fn(),
};

describe('CreateEvalForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders all main sections', () => {
    render(<CreateEvalForm {...defaultProps} />);

    expect(screen.getByText('Basic Info')).toBeInTheDocument();
    expect(screen.getByText('Evidence')).toBeInTheDocument();
    expect(screen.getByText('Inputs')).toBeInTheDocument();
    expect(screen.getByText('Checks')).toBeInTheDocument();
    expect(screen.getByText('LLM Judge (optional)')).toBeInTheDocument();
  });

  it('shows error when required fields are empty and Create Eval is clicked', async () => {
    render(<CreateEvalForm {...defaultProps} />);

    // Remove the default input so the form fails at "name is required"
    fireEvent.click(screen.getByRole('button', { name: /create eval/i }));

    await waitFor(() => {
      expect(screen.getByText('Name is required')).toBeInTheDocument();
    });

    expect(defaultProps.onCreate).not.toHaveBeenCalled();
  });

  it('shows evidence type-specific fields when "Source" option appears for log_query', async () => {
    render(<CreateEvalForm {...defaultProps} />);

    // Select evidence type = log_query — the first combobox in the form is the evidence type select
    const allSelects = screen.getAllByRole('combobox');
    const evidenceSelect = allSelects[0];
    fireEvent.change(evidenceSelect, { target: { value: 'log_query' } });

    await waitFor(() => {
      expect(screen.getByText('Source')).toBeInTheDocument();
    });

    expect(screen.getByText(/filter \(regex\)/i)).toBeInTheDocument();
  });

  it('shows Expected Outcome field when judge prompt text is entered', async () => {
    render(<CreateEvalForm {...defaultProps} />);

    const judgePromptTextarea = screen.getByPlaceholderText(/instructions for the llm judge/i);
    fireEvent.change(judgePromptTextarea, { target: { value: 'Evaluate whether the response is correct.' } });

    await waitFor(() => {
      expect(screen.getByText('Expected Outcome *')).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText(/what does a passing result look like/i)).toBeInTheDocument();
  });

  it('can add checks via Add Check button', async () => {
    render(<CreateEvalForm {...defaultProps} />);

    // Initially no check cards rendered (hint text is shown)
    expect(screen.getByText(/no deterministic checks/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add check/i }));

    await waitFor(() => {
      expect(screen.getByText(/select check type/i)).toBeInTheDocument();
    });

    // Hint text should be gone now
    expect(screen.queryByText(/no deterministic checks/i)).not.toBeInTheDocument();
  });

  it('calls onClose when back button is clicked', () => {
    render(<CreateEvalForm {...defaultProps} />);

    fireEvent.click(screen.getByText(/back to folders/i));

    expect(defaultProps.onClose).toHaveBeenCalled();
  });
});
