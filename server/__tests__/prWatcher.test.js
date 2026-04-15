import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExecFile = vi.fn();

vi.mock('child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
  default: { execFile: (...args) => mockExecFile(...args) },
}));

describe('prWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function getModule() {
    return await import('../services/prWatcher.js');
  }

  it('starts and stops a watcher without errors', async () => {
    // Mock gh pr list to return empty array
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      cb(null, '[]', '');
    });

    const { startPrWatcher, stopPrWatcher, isWatching } = await getModule();

    expect(isWatching('test-project')).toBe(false);

    const callback = vi.fn();
    startPrWatcher('test-project', '/tmp/project', callback, 5000);

    expect(isWatching('test-project')).toBe(true);

    stopPrWatcher('test-project');
    expect(isWatching('test-project')).toBe(false);
  });

  it('does not start duplicate watchers', async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      cb(null, '[]', '');
    });

    const { startPrWatcher, stopPrWatcher } = await getModule();

    const callback = vi.fn();
    startPrWatcher('test-project', '/tmp/project', callback, 5000);
    startPrWatcher('test-project', '/tmp/project', callback, 5000); // should be a no-op

    // Only one initial poll should happen
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    stopPrWatcher('test-project');
  });

  it('calls callback when PR head SHA changes', async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      callCount++;
      if (callCount === 1) {
        // First poll: seed with initial SHA
        cb(null, JSON.stringify([{ number: 42, headRefOid: 'abc123', title: 'Test PR' }]), '');
      } else {
        // Second poll: SHA changed
        cb(null, JSON.stringify([{ number: 42, headRefOid: 'def456', title: 'Test PR' }]), '');
      }
    });

    const { startPrWatcher, stopPrWatcher } = await getModule();

    const callback = vi.fn();
    startPrWatcher('test-project', '/tmp/project', callback, 5000);

    // First poll happened synchronously in startPrWatcher — no callback yet (just seeding)
    expect(callback).not.toHaveBeenCalled();

    // Advance timer to trigger second poll
    await vi.advanceTimersByTimeAsync(5000);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('test-project', 42, 'def456');

    stopPrWatcher('test-project');
  });

  it('does not call callback when PR SHA is unchanged', async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      cb(null, JSON.stringify([{ number: 42, headRefOid: 'abc123', title: 'Test PR' }]), '');
    });

    const { startPrWatcher, stopPrWatcher } = await getModule();

    const callback = vi.fn();
    startPrWatcher('test-project', '/tmp/project', callback, 5000);

    await vi.advanceTimersByTimeAsync(5000);

    // SHA didn't change, so no callback
    expect(callback).not.toHaveBeenCalled();

    stopPrWatcher('test-project');
  });

  it('handles gh CLI errors gracefully', async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      cb(new Error('gh not authenticated'), '', 'not authenticated');
    });

    const { startPrWatcher, stopPrWatcher } = await getModule();

    const callback = vi.fn();
    // Should not throw
    startPrWatcher('test-project', '/tmp/project', callback, 5000);

    await vi.advanceTimersByTimeAsync(5000);

    expect(callback).not.toHaveBeenCalled();

    stopPrWatcher('test-project');
  });

  it('stopAllPrWatchers clears all watchers', async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      cb(null, '[]', '');
    });

    const { startPrWatcher, stopAllPrWatchers, isWatching } = await getModule();

    startPrWatcher('project-1', '/tmp/p1', vi.fn(), 5000);
    startPrWatcher('project-2', '/tmp/p2', vi.fn(), 5000);

    expect(isWatching('project-1')).toBe(true);
    expect(isWatching('project-2')).toBe(true);

    stopAllPrWatchers();

    expect(isWatching('project-1')).toBe(false);
    expect(isWatching('project-2')).toBe(false);
  });
});
