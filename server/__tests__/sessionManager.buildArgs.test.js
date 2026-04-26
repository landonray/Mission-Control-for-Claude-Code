import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { createRequire } from 'module';

process.env.DATABASE_URL = 'postgresql://test:test@host.test/db';

const require = createRequire(import.meta.url);

// Stub the database module so importing sessionManager doesn't hit Neon.
const databasePath = path.resolve(__dirname, '..', 'database.js');
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
};

const { SessionProcess } = require('../services/sessionManager.js');

describe('SessionProcess.buildArgs', () => {
  // The Claude CLI argument parser treats any argv element starting with "--"
  // as an option flag. If the prompt content starts with "--" (which the
  // Mission Control planning preamble does), the CLI crashes with
  // "error: unknown option '...'" and never processes the message.
  // Inserting a "--" separator before the prompt tells the CLI to stop parsing
  // options, so any prompt content is treated as a positional argument.
  it('inserts a -- separator immediately before the prompt argument', async () => {
    const proc = new SessionProcess('test-session-id', {
      workingDirectory: '/tmp',
      permissionMode: 'auto',
      model: 'claude-opus-4-7',
    });

    const args = await proc.buildArgs('-- Mission Control preamble starts with dashes\n\nThis is a test');

    // Prompt is always the last arg.
    const promptIndex = args.length - 1;
    expect(args[promptIndex - 1]).toBe('--');
  });
});
