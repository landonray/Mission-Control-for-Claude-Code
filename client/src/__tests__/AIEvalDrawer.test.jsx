// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AIEvalDrawer from '../components/Quality/AIEvalDrawer';

// Mock the api module
vi.mock('../utils/api', () => ({
  api: {
    post: vi.fn().mockResolvedValue({ jobId: 'test-job-123' }),
  },
}));

// Mock WebSocket
class MockWebSocket {
  constructor() { this.onmessage = null; }
  close() {}
}
global.WebSocket = MockWebSocket;

describe('AIEvalDrawer', () => {
  it('renders input form in default mode', () => {
    render(
      <AIEvalDrawer
        folderPath="/project/evals/test"
        folderName="test"
        projectId="proj-123"
        onComplete={() => {}}
        onCancel={() => {}}
        onBuildManually={() => {}}
      />
    );

    expect(screen.getByText('Build Eval with AI')).toBeTruthy();
    expect(screen.getByPlaceholderText(/Check that recipe/)).toBeTruthy();
    expect(screen.getByText('Build with AI')).toBeTruthy();
  });

  it('disables submit when description is empty', () => {
    render(
      <AIEvalDrawer
        folderPath="/project/evals/test"
        folderName="test"
        projectId="proj-123"
        onComplete={() => {}}
        onCancel={() => {}}
        onBuildManually={() => {}}
      />
    );

    const submitBtn = screen.getByText('Build with AI');
    expect(submitBtn.disabled).toBe(true);
  });

  it('shows refinement fields in refinement mode', () => {
    render(
      <AIEvalDrawer
        folderPath="/project/evals/test"
        folderName="test"
        projectId="proj-123"
        onComplete={() => {}}
        onCancel={() => {}}
        onBuildManually={() => {}}
        refinementMode
        originalDescription="Check API returns JSON"
        currentFormState={{ name: 'api-check' }}
      />
    );

    expect(screen.getByText('Refine Eval')).toBeTruthy();
    expect(screen.getByText('What would you like to change?')).toBeTruthy();
  });

  it('calls onCancel when cancel is clicked', () => {
    const onCancel = vi.fn();
    render(
      <AIEvalDrawer
        folderPath="/project/evals/test"
        folderName="test"
        projectId="proj-123"
        onComplete={() => {}}
        onCancel={onCancel}
        onBuildManually={() => {}}
      />
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('enables submit when description is not empty', () => {
    render(
      <AIEvalDrawer
        folderPath="/project/evals/test"
        folderName="test"
        projectId="proj-123"
        onComplete={() => {}}
        onCancel={() => {}}
        onBuildManually={() => {}}
      />
    );

    const textarea = screen.getByPlaceholderText(/Check that recipe/);
    fireEvent.change(textarea, { target: { value: 'Check API response format' } });
    const submitBtn = screen.getByText('Build with AI');
    expect(submitBtn.disabled).toBe(false);
  });
});
