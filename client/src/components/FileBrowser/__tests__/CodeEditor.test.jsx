import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CodeEditor from '../CodeEditor';

// Mock the API module
vi.mock('../../../utils/api', () => ({
  api: {
    put: vi.fn(),
  },
}));

// Mock CSS modules
vi.mock('../CodeEditor.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

import { api } from '../../../utils/api';

describe('CodeEditor', () => {
  const defaultProps = {
    code: 'const x = 1;\nconst y = 2;',
    filePath: '/Users/testuser/projects/test.js',
    onSave: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with the provided code content', () => {
    render(<CodeEditor {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    expect(textarea.value).toBe(defaultProps.code);
  });

  it('renders line numbers matching the number of lines', () => {
    const { container } = render(<CodeEditor {...defaultProps} />);
    // 2 lines of code should produce line numbers containing "1" and "2"
    const lineNumbersEl = container.querySelector('.lineNumbers');
    expect(lineNumbersEl).toBeTruthy();
    expect(lineNumbersEl.textContent).toContain('1');
    expect(lineNumbersEl.textContent).toContain('2');
  });

  it('shows Save and Cancel buttons', () => {
    render(<CodeEditor {...defaultProps} />);
    expect(screen.getByText('Save')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('disables Save when no changes have been made', () => {
    render(<CodeEditor {...defaultProps} />);
    const saveButton = screen.getByText('Save').closest('button');
    expect(saveButton.disabled).toBe(true);
  });

  it('enables Save when content is modified', async () => {
    render(<CodeEditor {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'modified content' } });
    const saveButton = screen.getByText('Save').closest('button');
    expect(saveButton.disabled).toBe(false);
  });

  it('shows "Unsaved changes" indicator when content differs', () => {
    render(<CodeEditor {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'modified content' } });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('calls onCancel when Cancel button is clicked', () => {
    render(<CodeEditor {...defaultProps} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(defaultProps.onCancel).toHaveBeenCalledOnce();
  });

  it('calls API and onSave on successful save', async () => {
    api.put.mockResolvedValueOnce({ success: true });
    render(<CodeEditor {...defaultProps} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'new content' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/files/content', {
        path: defaultProps.filePath,
        content: 'new content',
      });
    });

    await waitFor(() => {
      expect(defaultProps.onSave).toHaveBeenCalledWith('new content');
    });
  });

  it('shows error message when save fails', async () => {
    api.put.mockRejectedValueOnce(new Error('Permission denied'));
    render(<CodeEditor {...defaultProps} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'new content' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.getByText('Permission denied')).toBeTruthy();
    });
  });

  it('inserts spaces when Tab key is pressed', () => {
    render(<CodeEditor {...defaultProps} />);
    const textarea = screen.getByRole('textbox');

    // Set cursor position
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    fireEvent.keyDown(textarea, { key: 'Tab' });

    expect(textarea.value.startsWith('  ')).toBe(true);
  });
});
