// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import NewPipelineDialog from '../NewPipelineDialog';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { post: vi.fn() },
}));

vi.mock('../../../utils/api', () => ({ api: mockApi }));
vi.mock('../NewPipelineDialog.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

let fileReaderInstance;
const mockReadAsText = vi.fn();

class MockFileReader {
  constructor() {
    fileReaderInstance = this;
    this.onload = null;
  }
  readAsText(file) {
    mockReadAsText(file);
  }
}

describe('NewPipelineDialog', () => {
  beforeEach(() => {
    mockApi.post.mockReset();
    mockReadAsText.mockReset();
    fileReaderInstance = null;
    window.FileReader = MockFileReader;
  });

  afterEach(cleanup);

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

  describe('File attachment', () => {
    function getFileInput() {
      return document.querySelector('input[type="file"]');
    }

    function attachFile(file) {
      const fileInput = getFileInput();
      Object.defineProperty(fileInput, 'files', {
        value: [file],
        configurable: true,
      });
      fireEvent.change(fileInput);
    }

    function triggerFileLoad(content) {
      act(() => {
        fileReaderInstance.onload({ target: { result: content } });
      });
    }

    // QA 2.1 — valid .md file populates spec textarea and shows indicator
    it('2.1 reads a valid .md file and populates the spec textarea', () => {
      render(<NewPipelineDialog projectId="p1" onClose={() => {}} onCreated={() => {}} />);
      const file = new File(['# My spec'], 'spec.md', { type: 'text/markdown' });
      attachFile(file);
      triggerFileLoad('# My spec');
      expect(screen.getByLabelText(/spec/i).value).toBe('# My spec');
      expect(screen.getByText(/spec\.md attached/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /remove attachment/i })).toBeTruthy();
    });

    // QA 2.2 — valid .txt file accepted
    it('2.2 reads a valid .txt file and populates the spec textarea', () => {
      render(<NewPipelineDialog projectId="p1" onClose={() => {}} onCreated={() => {}} />);
      const file = new File(['plain text spec'], 'notes.txt', { type: 'text/plain' });
      attachFile(file);
      triggerFileLoad('plain text spec');
      expect(screen.getByLabelText(/spec/i).value).toBe('plain text spec');
      expect(screen.getByText(/notes\.txt attached/)).toBeTruthy();
    });

    // QA 2.3 — clearing indicator preserves textarea content
    it('2.3 clearing the attachment indicator does not clear the textarea', () => {
      render(<NewPipelineDialog projectId="p1" onClose={() => {}} onCreated={() => {}} />);
      const file = new File(['# content'], 'spec.md', { type: 'text/markdown' });
      attachFile(file);
      triggerFileLoad('# content');
      expect(screen.getByText(/spec\.md attached/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /remove attachment/i }));
      expect(screen.queryByText(/spec\.md attached/)).toBeNull();
      expect(screen.getByLabelText(/spec/i).value).toBe('# content');
    });

    // QA 2.4 — second file overwrites first
    it('2.4 attaching a second file overwrites the first file content', () => {
      render(<NewPipelineDialog projectId="p1" onClose={() => {}} onCreated={() => {}} />);
      const file1 = new File(['first content'], 'first.md', { type: 'text/markdown' });
      attachFile(file1);
      triggerFileLoad('first content');
      expect(screen.getByLabelText(/spec/i).value).toBe('first content');

      const file2 = new File(['second content'], 'second.md', { type: 'text/markdown' });
      attachFile(file2);
      triggerFileLoad('second content');
      expect(screen.getByLabelText(/spec/i).value).toBe('second content');
      expect(screen.getByText(/second\.md attached/)).toBeTruthy();
    });

    // QA 2.5 — submitted spec is whatever is in textarea at submit time
    it('2.5 submits whatever is in the textarea after editing, not the original file content', async () => {
      mockApi.post.mockResolvedValue({ id: 'pipe_1', status: 'running' });
      render(<NewPipelineDialog projectId="p1" onClose={() => {}} onCreated={() => {}} />);
      fireEvent.change(screen.getByLabelText(/pipeline name/i), { target: { value: 'My Pipeline' } });
      const file = new File(['original spec'], 'spec.md', { type: 'text/markdown' });
      attachFile(file);
      triggerFileLoad('original spec');
      fireEvent.change(screen.getByLabelText(/spec/i), { target: { value: 'edited spec' } });
      fireEvent.click(screen.getByRole('button', { name: /start pipeline/i }));
      await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/pipelines', {
        project_id: 'p1', name: 'My Pipeline', spec_input: 'edited spec',
      }));
    });

    // QA 2.6 — file too large shows error, FileReader not called
    it('2.6 shows error and does not read file when file exceeds 500KB', () => {
      render(<NewPipelineDialog projectId="p1" onClose={() => {}} onCreated={() => {}} />);
      const file = { name: 'big.md', type: 'text/markdown', size: 524289 };
      attachFile(file);
      expect(mockReadAsText).not.toHaveBeenCalled();
      expect(screen.getByText(/too large to attach/i)).toBeTruthy();
      expect(screen.getByLabelText(/spec/i).value).toBe('');
    });

    // QA 2.7 — non-text file rejected, FileReader not called
    it('2.7 shows error and does not read file when file type is not text', () => {
      render(<NewPipelineDialog projectId="p1" onClose={() => {}} onCreated={() => {}} />);
      const file = { name: 'document.pdf', type: 'application/pdf', size: 1024 };
      attachFile(file);
      expect(mockReadAsText).not.toHaveBeenCalled();
      expect(screen.getByText(/only plain text or markdown/i)).toBeTruthy();
      expect(screen.getByLabelText(/spec/i).value).toBe('');
    });

    // QA 2.8 — parameterized file type acceptance
    describe('2.8 file type acceptance rules', () => {
      const cases = [
        { fileName: 'spec.md', type: 'text/markdown', expected: true },
        { fileName: 'spec.txt', type: 'text/plain', expected: true },
        { fileName: 'spec.markdown', type: 'text/markdown', expected: true },
        { fileName: 'spec.md', type: 'application/octet-stream', expected: true },
        { fileName: 'spec.pdf', type: 'application/pdf', expected: false },
        { fileName: 'spec.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', expected: false },
        { fileName: 'image.png', type: 'image/png', expected: false },
      ];

      cases.forEach(({ fileName, type, expected }) => {
        it(`${expected ? 'accepts' : 'rejects'} ${fileName} (${type})`, () => {
          render(<NewPipelineDialog projectId="p1" onClose={() => {}} onCreated={() => {}} />);
          const file = { name: fileName, type, size: 100 };
          attachFile(file);
          if (expected) {
            expect(mockReadAsText).toHaveBeenCalled();
            expect(screen.queryByText(/only plain text or markdown/i)).toBeNull();
          } else {
            expect(mockReadAsText).not.toHaveBeenCalled();
            expect(screen.getByText(/only plain text or markdown/i)).toBeTruthy();
          }
        });
      });
    });

    // QA 2.9 — submit gating unchanged; file attachment path enables button
    it('2.9 submit button gating: disabled without name; enabled when name + spec from file', () => {
      render(<NewPipelineDialog projectId="p1" onClose={() => {}} onCreated={() => {}} />);
      const submitBtn = screen.getByRole('button', { name: /start pipeline/i });
      expect(submitBtn.disabled).toBe(true);

      fireEvent.change(screen.getByLabelText(/pipeline name/i), { target: { value: 'My Pipeline' } });
      expect(submitBtn.disabled).toBe(true);

      const file = new File(['# spec'], 'spec.md', { type: 'text/markdown' });
      attachFile(file);
      triggerFileLoad('# spec');
      expect(submitBtn.disabled).toBe(false);

      fireEvent.change(screen.getByLabelText(/spec/i), { target: { value: '' } });
      expect(submitBtn.disabled).toBe(true);
    });

    // QA 2.10 — file content submitted as spec_input string, no multipart
    it('2.10 submits file content as plain string spec_input, not a File or FormData', async () => {
      mockApi.post.mockResolvedValue({ id: 'pipe_1', status: 'running' });
      render(<NewPipelineDialog projectId="p1" onClose={() => {}} onCreated={() => {}} />);
      fireEvent.change(screen.getByLabelText(/pipeline name/i), { target: { value: 'Pipeline' } });
      const file = new File(['file spec content'], 'spec.md', { type: 'text/markdown' });
      attachFile(file);
      triggerFileLoad('file spec content');
      fireEvent.click(screen.getByRole('button', { name: /start pipeline/i }));
      await waitFor(() => {
        expect(mockApi.post).toHaveBeenCalledWith('/api/pipelines', expect.objectContaining({
          spec_input: 'file spec content',
        }));
        const body = mockApi.post.mock.calls[0][1];
        expect(typeof body.spec_input).toBe('string');
      });
    });
  });
});
