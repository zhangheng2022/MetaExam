import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  publicDir: fileURLToPath(new URL('../../packages/ui/public', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: Number(process.env.METAEXAM_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:' + (process.env.METAEXAM_API_PORT ?? 3000),
      '/health': 'http://127.0.0.1:' + (process.env.METAEXAM_API_PORT ?? 3000),
    },
  },
});
