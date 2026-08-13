/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    // Expose vitest globals so @testing-library/react auto-cleans the DOM
    // between tests.
    globals: true,
    setupFiles: './tests/setup.ts',
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
  },
  server: {
    port: 5173,
    proxy: {
      // Local dev against a port-forwarded apps-api.
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
});
