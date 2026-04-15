// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FilePreview from '../FilePreview';

// Mock CSS modules
vi.mock('../FilePreview.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));
vi.mock('../CodePreview.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));
vi.mock('../CodeEditor.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));
vi.mock('../MarkdownPreview.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

// Mock the API module (used by CodeEditor)
vi.mock('../../../utils/api', () => ({
  api: {
    put: vi.fn(),
  },
}));

describe('FilePreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Edit button for text files', () => {
    render(
      <FilePreview
        content={{ type: 'text', content: 'hello world', size: 11 }}
        filePath="/test/file.js"
      />
    );
    expect(screen.getByText('Edit')).toBeTruthy();
  });

  it('shows Edit button for markdown files', () => {
    render(
      <FilePreview
        content={{ type: 'markdown', content: '# Hello' }}
        filePath="/test/file.md"
      />
    );
    expect(screen.getByText('Edit')).toBeTruthy();
  });

  it('shows Edit button for HTML files', () => {
    render(
      <FilePreview
        content={{ type: 'html', content: '<h1>Hi</h1>' }}
        filePath="/test/file.html"
      />
    );
    expect(screen.getByText('Edit')).toBeTruthy();
  });

  it('does NOT show Edit button for binary files', () => {
    render(
      <FilePreview
        content={{ type: 'binary', size: 1024 }}
        filePath="/test/file.bin"
      />
    );
    expect(screen.queryByText('Edit')).toBeNull();
  });

  it('does NOT show Edit button for image files', () => {
    render(
      <FilePreview
        content={{ type: 'image', content: 'data:image/png;base64,...' }}
        filePath="/test/image.png"
      />
    );
    expect(screen.queryByText('Edit')).toBeNull();
  });

  it('does NOT show Edit button for error content', () => {
    render(
      <FilePreview
        content={{ type: 'error', content: 'File not found' }}
        filePath="/test/missing.js"
      />
    );
    expect(screen.queryByText('Edit')).toBeNull();
  });

  it('switches to editor when Edit is clicked', () => {
    render(
      <FilePreview
        content={{ type: 'text', content: 'const x = 1;', size: 13 }}
        filePath="/test/file.js"
      />
    );

    fireEvent.click(screen.getByText('Edit'));

    // Editor should now be visible (has a textarea)
    expect(screen.getByRole('textbox')).toBeTruthy();
    // Edit button should be hidden while editing
    expect(screen.queryByText('Edit')).toBeNull();
    // Save and Cancel should be visible
    expect(screen.getByText('Save')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('exits editor when Cancel is clicked', () => {
    render(
      <FilePreview
        content={{ type: 'text', content: 'const x = 1;', size: 13 }}
        filePath="/test/file.js"
      />
    );

    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByRole('textbox')).toBeTruthy();

    fireEvent.click(screen.getByText('Cancel'));
    // Should be back to preview mode
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Edit')).toBeTruthy();
  });

  it('returns null when content is null', () => {
    const { container } = render(
      <FilePreview content={null} filePath="/test/file.js" />
    );
    expect(container.innerHTML).toBe('');
  });
});
