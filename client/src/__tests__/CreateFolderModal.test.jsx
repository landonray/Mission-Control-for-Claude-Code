// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// Lucide icons — render as simple spans
vi.mock('lucide-react', () => ({
  X: (props) => React.createElement('span', { 'data-testid': 'icon-x', ...props }),
}));

// Mock CSS modules
vi.mock('../components/Quality/CreateFolderModal.module.css', () => ({ default: {} }));

import CreateFolderModal from '../components/Quality/CreateFolderModal';

describe('CreateFolderModal', () => {
  const onClose = vi.fn();
  const onCreate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders input field, Create Folder button, and Cancel button', () => {
    render(<CreateFolderModal onClose={onClose} onCreate={onCreate} />);

    expect(screen.getByPlaceholderText(/e\.g\. api-checks/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create folder/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('shows error when submitting with empty name', async () => {
    render(<CreateFolderModal onClose={onClose} onCreate={onCreate} />);

    fireEvent.click(screen.getByRole('button', { name: /create folder/i }));

    await waitFor(() => {
      expect(screen.getByText('Folder name is required')).toBeInTheDocument();
    });

    expect(onCreate).not.toHaveBeenCalled();
  });

  it('calls onCreate with folder name on successful submit, then calls onClose', async () => {
    onCreate.mockResolvedValueOnce(undefined);

    render(<CreateFolderModal onClose={onClose} onCreate={onCreate} />);

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. api-checks/i), {
      target: { value: 'my-folder' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create folder/i }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith('my-folder');
    });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('rejects path traversal characters in folder name', async () => {
    render(<CreateFolderModal onClose={onClose} onCreate={onCreate} />);

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. api-checks/i), {
      target: { value: '../dangerous' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create folder/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid folder name')).toBeInTheDocument();
    });

    expect(onCreate).not.toHaveBeenCalled();
  });

  it('calls onClose when Cancel is clicked', () => {
    render(<CreateFolderModal onClose={onClose} onCreate={onCreate} />);

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onClose).toHaveBeenCalled();
  });
});
