import { defineConfig } from 'vitest/config';
import path from 'path';
import { existsSync } from 'fs';

// React lives in client/node_modules — resolve from there to avoid version mismatch
// with root node_modules (which may have a different React version).
// In worktrees, client/node_modules may not exist — fall back to main project's client.
const clientModules = path.resolve(__dirname, 'client/node_modules');
const mainClientModules = path.resolve(__dirname, '../../../client/node_modules');
const rootNodeModules = existsSync(path.join(clientModules, 'react')) ? clientModules : mainClientModules;

export default defineConfig({
  resolve: {
    alias: {
      react: path.resolve(rootNodeModules, 'react'),
      'react-dom': path.resolve(rootNodeModules, 'react-dom'),
      'react/jsx-runtime': path.resolve(rootNodeModules, 'react/jsx-runtime'),
      'react/jsx-dev-runtime': path.resolve(rootNodeModules, 'react/jsx-dev-runtime'),
    },
  },
  test: {
    globals: true,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/worktrees/**',
      '**/.worktrees/**',
    ],
    environmentMatchGlobs: [
      ['client/**/*.test.*', 'jsdom'],
    ],
  },
});
