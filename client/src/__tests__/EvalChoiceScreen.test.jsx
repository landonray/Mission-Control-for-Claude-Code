// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EvalChoiceScreen from '../components/Quality/EvalChoiceScreen';

describe('EvalChoiceScreen', () => {
  it('renders both options', () => {
    render(
      <EvalChoiceScreen
        folderName="api-tests"
        onChooseAI={() => {}}
        onChooseManual={() => {}}
        onClose={() => {}}
      />
    );

    expect(screen.getByText('Build with AI')).toBeTruthy();
    expect(screen.getByText('Build manually')).toBeTruthy();
    expect(screen.getByText('api-tests')).toBeTruthy();
  });

  it('calls onChooseAI when AI button is clicked', () => {
    const onChooseAI = vi.fn();
    render(
      <EvalChoiceScreen
        folderName="api-tests"
        onChooseAI={onChooseAI}
        onChooseManual={() => {}}
        onClose={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Build with AI'));
    expect(onChooseAI).toHaveBeenCalledOnce();
  });

  it('calls onChooseManual when manual link is clicked', () => {
    const onChooseManual = vi.fn();
    render(
      <EvalChoiceScreen
        folderName="api-tests"
        onChooseAI={() => {}}
        onChooseManual={onChooseManual}
        onClose={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Build manually'));
    expect(onChooseManual).toHaveBeenCalledOnce();
  });

  it('calls onClose when back button is clicked', () => {
    const onClose = vi.fn();
    render(
      <EvalChoiceScreen
        folderName="api-tests"
        onChooseAI={() => {}}
        onChooseManual={() => {}}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByText('Back to folders'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
