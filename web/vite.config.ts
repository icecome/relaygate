import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 后端默认 19900（见根目录 .env 的 PORT）。vite dev 下把 /v1 与 /status
// 代理到后端，避免 CORS；生产构建后由 Express 直接托管 dist。
const BACKEND_PORT = Number(process.env.VITE_BACKEND_PORT || process.env.RELAY_PORT) || 19900;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': { target: `http://127.0.0.1:${BACKEND_PORT}`, changeOrigin: true },
      '/status': { target: `http://127.0.0.1:${BACKEND_PORT}`, changeOrigin: true },
      '/health': { target: `http://127.0.0.1:${BACKEND_PORT}`, changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
});