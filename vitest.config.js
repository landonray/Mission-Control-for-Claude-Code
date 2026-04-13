import { defineConfig } from 'vitest/config';
import path from 'path';
import { existsSync } from 'fs';

// In worktrees, node_modules may not exist — fall back to the main project's root
const localRootModules = path.resolve(__dirname, 'node_modules');
const mainRootModules = path.resolve(__dirname, '../../../node_modules');
// Use main project root modules for react (consistent with @testing-library/react resolution)
const rootNodeModules = existsSync(path.join(localRootModules, 'react')) ? localRootModules : mainRootModules;

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
    environmentMatchGlobs: [
      ['client/**/*.test.*', 'jsdom'],
    ],
  },
});
