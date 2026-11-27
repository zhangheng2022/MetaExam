import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  root: 'renderer',
  base: './',
  build: { outDir: '../renderer-dist', emptyOutDir: true },
});
