import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages project site is served from /sinuosity/. Keep local dev/preview at root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/sinuosity/' : '/',
  plugins: [react()],
  server: { port: 5173, host: true },
}));
