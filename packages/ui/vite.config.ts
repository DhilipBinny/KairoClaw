import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    proxy: {
      '/api': 'http://localhost:18181',
      '/ws': { target: 'ws://localhost:18181', ws: true },
    },
  },
});
