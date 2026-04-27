// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewPipelineDialog from '../NewPipelineDialog';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { post: vi.fn() },
}));

vi.mock('../../../utils/api', () => ({ api: mockApi }));
vi.mock('../NewPipelineDialog.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

describe('NewPipelineDialog', () => {
  beforeEach(() => { mockApi.post.mockReset(); });

  it('renders name and spec input fields', () => {
    render(<NewPipelineDialog projectId="p1" onClose={() => {}} onCreated={() => {}} />);
    expect(screen.getByLabelText(/pipeline name/i)).toBeTruthy();
    expect(screen.getByLabelText(/spec/i)).toBeTruthy();
  });

  it('disables submit while name or spec is empty', () => {
    render(<NewPipelineDialog projectId="p1" onClose={() => {}} onCreated={() => {}} />);
    const button = screen.getByRole('button', { name: /start pipeline/i });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/pipeline name/i), { target: { value: 'Name' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/spec/i), { target: { value: 'Spec text' } });
    expect(button.disabled).toBe(false);
  });

  it('submits and calls onCreated on success', async () => {
    mockApi.post.mockResolvedValue({ id: 'pipe_new', status: 'running' });
    const onCreated = vi.fn();
    render(<NewPipelineDialog projectId="p1" onClose={() => {}} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText(/pipeline name/i), { target: { value: 'Add foo' } });
    fireEvent.change(screen.getByLabelText(/spec/i), { target: { value: 'Build foo widget.' } });
    fireEvent.click(screen.getByRole('button', { name: /start pipeline/i }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/pipelines', {
      project_id: 'p1', name: 'Add foo', spec_input: 'Build foo widget.',
    }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'pipe_new', status: 'running' }));
  });

  it('shows the server error message on failure', async () => {
    mockApi.post.mockRejectedValue(new Error('Project already has an active pipeline'));
    render(<NewPipelineDialog projectId="p1" onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText(/pipeline name/i), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText(/spec/i), { target: { value: 'Spec.' } });
    fireEvent.click(screen.getByRole('button', { name: /start pipeline/i }));
    await waitFor(() => expect(screen.getByText(/already has an active pipeline/i)).toBeTruthy());
  });
});
