// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SlashCommandsSettings from '../SlashCommandsSettings.jsx';

vi.mock('../../../utils/api', () => ({
  api: {
    get: vi.fn((url) => {
      if (url === '/api/slash-commands') return Promise.resolve({ commands: [] });
      if (url === '/api/merge-fields') return Promise.resolve({ fields: [{ name: 'last_pr', description: 'most recently updated open PR number' }] });
      return Promise.resolve({});
    }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

// Stub the CSS module so className lookups return stable strings in tests
vi.mock('../SlashCommandsSettings.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

describe('SlashCommandsSettings merge-field hint', () => {
  it('renders the available merge fields hint when creating a command', async () => {
    render(<SlashCommandsSettings />);
    // Wait for loading to finish, then open the New Command form
    const newBtn = await screen.findByText(/New Command/i);
    newBtn.click();
    await waitFor(() => {
      expect(screen.getByText(/Available merge fields/i)).toBeInTheDocument();
      expect(screen.getByText(/\{\{last_pr\}\}/)).toBeInTheDocument();
      expect(screen.getByText(/most recently updated open PR number/i)).toBeInTheDocument();
    });
  });
});
