import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  publicDir: fileURLToPath(new URL('../../packages/ui/public', import.meta.url)),
  root: 'renderer',
  base: './',
  build: { outDir: '../renderer-dist', emptyOutDir: true },
});
