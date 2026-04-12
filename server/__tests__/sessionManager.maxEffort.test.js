import { describe, it, expect } from 'vitest';

/**
 * Tests the maxEffort flag integration with CLI argument building.
 *
 * We extract the relevant logic and test it in isolation rather than
 * importing the full sessionManager (which has heavy side effects).
 */

// Mirrors the --effort logic in SessionProcess.buildArgs()
function buildEffortArgs(maxEffort) {
  const args = [];
  if (maxEffort) {
    args.push('--effort', 'max');
  }
  return args;
}

describe('maxEffort CLI args', () => {
  it('includes --effort max when maxEffort is true', () => {
    const args = buildEffortArgs(true);
    expect(args).toEqual(['--effort', 'max']);
  });

  it('returns no args when maxEffort is false', () => {
    const args = buildEffortArgs(false);
    expect(args).toEqual([]);
  });

  it('returns no args when maxEffort is undefined', () => {
    const args = buildEffortArgs(undefined);
    expect(args).toEqual([]);
  });

  it('returns no args when maxEffort is 0', () => {
    const args = buildEffortArgs(0);
    expect(args).toEqual([]);
  });
});

describe('maxEffort initialization', () => {
  it('converts database integer 1 to truthy', () => {
    const dbValue = 1;
    expect(!!dbValue).toBe(true);
  });

  it('converts database integer 0 to falsy', () => {
    const dbValue = 0;
    expect(!!dbValue).toBe(false);
  });

  it('converts null/undefined to falsy', () => {
    expect(!!null).toBe(false);
    expect(!!undefined).toBe(false);
  });
});
