import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '');
  const vitePort = parseInt(env.VITE_PORT || '5173', 10);
  const apiPort = parseInt(env.PORT || '3001', 10);
  return {
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: vitePort,
    strictPort: true,
    allowedHosts: ['.ts.net', 'localhost', '127.0.0.1'],
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/ws': {
        target: `ws://localhost:${apiPort}`,
        ws: true
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
  };
});
