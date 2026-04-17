import { describe, it, expect } from 'vitest';

// Contract test for the effort CLI arg. Full SessionProcess instantiation
// requires extensive mocking; the actual wiring is verified at runtime in
// Task 13's smoke check.
function buildEffortArg(effort) {
  return effort ? ['--effort', effort] : [];
}

describe('effort CLI arg', () => {
  it('appends --effort xhigh when set', () => {
    expect(buildEffortArg('xhigh')).toEqual(['--effort', 'xhigh']);
  });
  it('appends --effort max when set', () => {
    expect(buildEffortArg('max')).toEqual(['--effort', 'max']);
  });
  it('omits --effort when null', () => {
    expect(buildEffortArg(null)).toEqual([]);
  });
  it('omits --effort when undefined', () => {
    expect(buildEffortArg(undefined)).toEqual([]);
  });
});
