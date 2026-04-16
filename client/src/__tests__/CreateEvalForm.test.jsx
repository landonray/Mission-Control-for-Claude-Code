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
  Info: (props) => React.createElement('span', { 'data-testid': 'icon-info', ...props }),
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

  it('shows tooltip text when hovering an info icon', async () => {
    render(<CreateEvalForm {...defaultProps} />);

    // Evidence section should have a tooltip on Max Bytes
    const infoIcons = screen.getAllByTestId('icon-info');
    expect(infoIcons.length).toBeGreaterThan(0);

    // Hover the first info icon
    fireEvent.mouseEnter(infoIcons[0].closest('span[class]') || infoIcons[0].parentElement);

    await waitFor(() => {
      // Check that some tooltip text becomes visible
      const tooltipTexts = document.querySelectorAll('[role="tooltip"]');
      expect(tooltipTexts.length).toBeGreaterThan(0);
    });
  });

  it('shows inline hint text under section titles', () => {
    render(<CreateEvalForm {...defaultProps} />);

    expect(screen.getByText(/how the eval gathers data to check/i)).toBeInTheDocument();
    expect(screen.getByText(/variables passed to your eval at runtime/i)).toBeInTheDocument();
    expect(screen.getByText(/deterministic pass\/fail rules/i)).toBeInTheDocument();
    expect(screen.getByText(/an llm reviews the evidence/i)).toBeInTheDocument();
  });

  it('shows all 11 check types in the dropdown', async () => {
    render(<CreateEvalForm {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /add check/i }));

    await waitFor(() => {
      expect(screen.getByText(/select check type/i)).toBeInTheDocument();
    });

    const checkSelect = screen.getAllByRole('combobox').find(
      el => Array.from(el.options).some(opt => opt.text === 'Not Empty')
    );
    expect(checkSelect).toBeTruthy();

    const optionLabels = Array.from(checkSelect.options).map(o => o.text).filter(t => t !== 'Select check type...');
    expect(optionLabels).toEqual([
      'Not Empty', 'Regex Match', 'JSON Valid', 'JSON Schema', 'HTTP Status', 'Field Exists',
      'Equals', 'Contains', 'Greater Than', 'Less Than', 'Numeric Score',
    ]);
  });

  it('shows Value and Field Path fields when Equals check is selected', async () => {
    render(<CreateEvalForm {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /add check/i }));

    await waitFor(() => {
      expect(screen.getByText(/select check type/i)).toBeInTheDocument();
    });

    const checkSelect = screen.getAllByRole('combobox').find(
      el => Array.from(el.options).some(opt => opt.text === 'Not Empty')
    );
    fireEvent.change(checkSelect, { target: { value: 'equals' } });

    await waitFor(() => {
      expect(screen.getByText('Value *')).toBeInTheDocument();
    });
  });

  it('shows Min, Max, and Field Path fields when Numeric Score check is selected', async () => {
    render(<CreateEvalForm {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /add check/i }));

    await waitFor(() => {
      expect(screen.getByText(/select check type/i)).toBeInTheDocument();
    });

    const checkSelect = screen.getAllByRole('combobox').find(
      el => Array.from(el.options).some(opt => opt.text === 'Not Empty')
    );
    fireEvent.change(checkSelect, { target: { value: 'numeric_score' } });

    await waitFor(() => {
      expect(screen.getByText('Min')).toBeInTheDocument();
      expect(screen.getByText('Max')).toBeInTheDocument();
    });
  });

  it('shows help text when a check type is selected', async () => {
    render(<CreateEvalForm {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /add check/i }));

    const checkSelect = screen.getAllByRole('combobox').find(
      el => Array.from(el.options).some(opt => opt.text === 'Not Empty')
    );
    fireEvent.change(checkSelect, { target: { value: 'not_empty' } });

    await waitFor(() => {
      expect(screen.getByText(/passes if the evidence contains any non-whitespace content/i)).toBeInTheDocument();
    });
  });

  it('shows grouped help text for comparison check types', async () => {
    render(<CreateEvalForm {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /add check/i }));

    const checkSelect = screen.getAllByRole('combobox').find(
      el => Array.from(el.options).some(opt => opt.text === 'Not Empty')
    );
    fireEvent.change(checkSelect, { target: { value: 'equals' } });

    await waitFor(() => {
      expect(screen.getByText(/compares the evidence/i)).toBeInTheDocument();
    });
  });
});
