import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
  },
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true },
});
