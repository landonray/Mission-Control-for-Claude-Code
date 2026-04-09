import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      react: path.resolve(__dirname, 'client/node_modules/react'),
      'react-dom': path.resolve(__dirname, 'client/node_modules/react-dom'),
      'react/jsx-runtime': path.resolve(__dirname, 'client/node_modules/react/jsx-runtime'),
      'react/jsx-dev-runtime': path.resolve(__dirname, 'client/node_modules/react/jsx-dev-runtime'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
  },
});
