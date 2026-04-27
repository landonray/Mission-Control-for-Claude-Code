import { defineConfig } from 'vitest/config';
import path from 'path';
import { existsSync } from 'fs';
import dotenv from 'dotenv';

// Load environment variables for tests
dotenv.config({ path: path.resolve(__dirname, '.env') });

// React lives in client/node_modules — resolve from there to avoid version mismatch
// with root node_modules (which may have a different React version).
// In worktrees, client/node_modules may not exist — fall back to main project's client.
const clientModules = path.resolve(__dirname, 'client/node_modules');
const mainClientModules = path.resolve(__dirname, '../../../client/node_modules');
const rootNodeModules = existsSync(path.join(clientModules, 'react')) ? clientModules : mainClientModules;

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
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
      // Anchored to project root (no leading **/) so the main repo skips its
      // worktrees but each worktree can still run its own tests.
      '.claude/worktrees/**',
      '.worktrees/**',
    ],
    environmentMatchGlobs: [
      ['client/**/*.test.*', 'jsdom'],
    ],
  },
});
