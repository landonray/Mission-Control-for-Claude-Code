// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import RulesConfig from '../RulesConfig.jsx';

vi.mock('../../../utils/api', () => ({
  api: {
    get: vi.fn((url) => {
      if (url === '/api/quality/rules') return Promise.resolve([
        {
          id: 'test-rule',
          name: 'Test Rule',
          description: 'A test rule',
          prompt: 'do a thing',
          script: null,
          enabled: 1,
          severity: 'low',
          fires_on: 'Stop',
          hook_type: 'prompt',
          category: 'quality',
        },
      ]);
      if (url === '/api/quality/hooks/status') return Promise.resolve({ installed: false, ruleCount: 0 });
      if (url === '/api/merge-fields') return Promise.resolve({
        fields: [{ name: 'last_pr', description: 'most recently updated open PR number' }],
      });
      return Promise.resolve({});
    }),
    post: vi.fn(),
    put: vi.fn(),
  },
}));

vi.mock('../RulesConfig.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

describe('RulesConfig merge-field hint', () => {
  it('renders the available merge fields hint when editing a rule prompt', async () => {
    render(<RulesConfig />);

    const ruleName = await screen.findByText('Test Rule');
    const ruleCard = ruleName.closest('.ruleCard');
    const expandBtn = ruleCard.querySelector('.expandBtn');
    expandBtn.click();

    const customizeBtn = await screen.findByRole('button', { name: /Customize/i });
    customizeBtn.click();

    await waitFor(() => {
      expect(screen.getByText(/Available merge fields/i)).toBeTruthy();
      expect(screen.getByText(/\{\{last_pr\}\}/)).toBeTruthy();
      expect(screen.getByText(/most recently updated open PR number/i)).toBeTruthy();
    });
  });
});
