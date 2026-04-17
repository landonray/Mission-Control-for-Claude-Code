// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import GeneralSettings from '../GeneralSettings.jsx';

const { mockApi, stableAppCtx } = vi.hoisted(() => {
  const stableSettings = {
    projects_directory: '/tmp',
    github_username: 'me',
    setup_repo: '',
    default_effort: 'high',
  };
  return {
    mockApi: {
      get: vi.fn(() => Promise.resolve({})),
      put: vi.fn(() => Promise.resolve({})),
      post: vi.fn(() => Promise.resolve({})),
    },
    stableAppCtx: {
      generalSettings: stableSettings,
      loadGeneralSettings: vi.fn(() => Promise.resolve()),
    },
  };
});

vi.mock('../../../utils/api', () => ({ api: mockApi }));

vi.mock('../../../context/AppContext', () => ({
  useApp: () => stableAppCtx,
}));

vi.mock('../GeneralSettings.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

vi.mock('../../shared/FolderPicker', () => ({
  default: () => null,
}));

describe('GeneralSettings default effort', () => {
  beforeEach(() => {
    mockApi.put.mockClear();
    stableAppCtx.loadGeneralSettings.mockClear();
  });

  it('renders a default-effort picker and saves the selection', async () => {
    render(<GeneralSettings />);
    await waitFor(() => {
      expect(screen.getByText(/Default effort for new sessions/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /^xHigh$/ }));

    await waitFor(() => {
      expect(mockApi.put).toHaveBeenCalledWith(
        '/api/settings/general',
        expect.objectContaining({ default_effort: 'xhigh' }),
      );
    });
  });
});
