import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

// The route module loads ../database at import time, which calls neon() and
// requires *some* DATABASE_URL string. The test never executes a query, so any
// non-empty placeholder is enough.
process.env.DATABASE_URL ||= 'postgresql://placeholder@localhost/test';

const require = createRequire(import.meta.url);
const { resolveSessionProjectName } = require('../routes/sessions');

describe('resolveSessionProjectName', () => {
  it('prefers the linked projects-table name when set', () => {
    expect(
      resolveSessionProjectName('AI-page-builder', '/Users/x/coding projects/AI-page-builder')
    ).toBe('AI-page-builder');
  });

  it('uses linked name even when working_directory is a worktree under a different-cased path', () => {
    expect(
      resolveSessionProjectName(
        'Event-calendar',
        '/Users/x/Coding Projects/Event-calendar/.claude/worktrees/abc'
      )
    ).toBe('Event-calendar');
  });

  it('falls back to worktree-parent basename when no linked project', () => {
    expect(
      resolveSessionProjectName(
        null,
        '/Users/x/Coding Projects/Event-calendar/.claude/worktrees/abc'
      )
    ).toBe('Event-calendar');
  });

  it('falls back to working_directory basename when no linked project and no worktree pattern', () => {
    expect(
      resolveSessionProjectName(null, '/Users/x/Coding Projects/Event-calendar')
    ).toBe('Event-calendar');
  });

  it('returns Ungrouped when no link and no working_directory', () => {
    expect(resolveSessionProjectName(null, null)).toBe('Ungrouped');
    expect(resolveSessionProjectName(undefined, undefined)).toBe('Ungrouped');
    expect(resolveSessionProjectName('', '')).toBe('Ungrouped');
  });
});
