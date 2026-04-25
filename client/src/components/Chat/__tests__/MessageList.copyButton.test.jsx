// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MessageList from '../MessageList';

vi.mock('../MessageList.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

vi.mock('../../FileBrowser/MarkdownPreview', () => ({
  default: ({ content }) => <div data-testid="md">{content}</div>,
}));

vi.mock('../../../utils/format', () => ({
  formatDate: () => 'just now',
}));

describe('MessageList copy button', () => {
  let writeText;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    Object.defineProperty(window, 'isSecureContext', {
      value: true,
      configurable: true,
    });
  });

  it('renders a copy button next to a user message and copies its content', async () => {
    render(
      <MessageList
        messages={[{ role: 'user', content: 'hello there', timestamp: '2026-04-25T12:00:00Z' }]}
        loading={false}
        streamEvents={[]}
        status="idle"
      />
    );

    const btn = screen.getByRole('button', { name: /copy message/i });
    expect(btn).toBeInTheDocument();

    fireEvent.click(btn);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('hello there');
    });
  });

  it('renders a copy button next to an assistant message and copies its content', async () => {
    render(
      <MessageList
        messages={[{ role: 'assistant', content: 'sure, here is the answer', timestamp: '2026-04-25T12:00:00Z' }]}
        loading={false}
        streamEvents={[]}
        status="idle"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /copy message/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('sure, here is the answer');
    });
  });

  it('does not show a copy button on queued messages', () => {
    render(
      <MessageList
        messages={[{ role: 'user', content: 'pending msg', queued: true, timestamp: '2026-04-25T12:00:00Z' }]}
        loading={false}
        streamEvents={[]}
        status="idle"
      />
    );

    expect(screen.queryByRole('button', { name: /copy message/i })).not.toBeInTheDocument();
  });

  it('does nothing gracefully when clipboard write fails', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText: failing } });

    render(
      <MessageList
        messages={[{ role: 'user', content: 'oops', timestamp: '2026-04-25T12:00:00Z' }]}
        loading={false}
        streamEvents={[]}
        status="idle"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /copy message/i }));

    await waitFor(() => {
      expect(failing).toHaveBeenCalledWith('oops');
    });
    // Component should not crash; button remains in the DOM
    expect(screen.getByRole('button', { name: /copy message/i })).toBeInTheDocument();
  });
});
