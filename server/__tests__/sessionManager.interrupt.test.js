import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';

// Mock execSync so we don't actually call tmux
vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process');
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

// Minimal Session-like object to test interrupt logic in isolation.
function makeSession({ status = 'working', tmux = true, sessionName = 'mc-test1234' } = {}) {
  return {
    id: 'test-session-id-12345678',
    status,
    process: tmux ? { tmux: true, sessionName } : null,
  };
}

// The interrupt logic we'll implement — extracted here for test clarity.
function interrupt(session) {
  if (session.status !== 'working') return false;
  if (!session.process || !session.process.tmux) return false;

  try {
    execSync(`tmux send-keys -t ${session.process.sessionName} Escape`, {
      stdio: 'ignore',
    });
    return true;
  } catch (e) {
    return false;
  }
}

describe('Session.interrupt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends Escape to tmux when session is working', () => {
    const session = makeSession();
    const result = interrupt(session);

    expect(result).toBe(true);
    expect(execSync).toHaveBeenCalledWith(
      'tmux send-keys -t mc-test1234 Escape',
      { stdio: 'ignore' }
    );
  });

  it('returns false when session is not working', () => {
    const session = makeSession({ status: 'idle' });
    const result = interrupt(session);

    expect(result).toBe(false);
    expect(execSync).not.toHaveBeenCalled();
  });

  it('returns false when no tmux process exists', () => {
    const session = makeSession({ tmux: false });
    const result = interrupt(session);

    expect(result).toBe(false);
    expect(execSync).not.toHaveBeenCalled();
  });

  it('returns false when execSync throws', () => {
    execSync.mockImplementation(() => { throw new Error('tmux error'); });
    const session = makeSession();
    const result = interrupt(session);

    expect(result).toBe(false);
  });
});
