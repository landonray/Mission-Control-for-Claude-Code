// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import StagePromptEditor from '../StagePromptEditor';

describe('StagePromptEditor', () => {
  it('renders the prompt for each stage', () => {
    render(<StagePromptEditor prompts={{ '1': 'A', '2': 'B', '3': 'C' }} onSave={vi.fn()} />);
    expect(screen.getByText(/Stage 1: Spec Refinement/i)).toBeTruthy();
    expect(screen.getByText(/Stage 2: QA Design/i)).toBeTruthy();
    expect(screen.getByText(/Stage 3: Implementation Planning/i)).toBeTruthy();
  });

  it('calls onSave with the new prompt when Save is clicked', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<StagePromptEditor prompts={{ '1': 'A', '2': 'B', '3': 'C' }} onSave={onSave} />);
    const editButtons = screen.getAllByText(/^Edit$/);
    fireEvent.click(editButtons[0]);
    const textarea = screen.getByDisplayValue('A');
    fireEvent.change(textarea, { target: { value: 'A updated' } });
    fireEvent.click(screen.getByText(/^Save$/));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(1, 'A updated'));
  });
});
