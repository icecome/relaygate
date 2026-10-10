import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 后端默认 19900（见根目录 .env 的 PORT）。vite dev 下把 /v1 与 /status
// 代理到后端，避免 CORS；生产构建后由 Express 直接托管 dist。
const BACKEND_PORT = Number(process.env.VITE_BACKEND_PORT || process.env.RELAY_PORT) || 19900;

// 版本号单一事实源：根 package.json（web/package.json 只是子包，不单独维护版本）。
// 侧栏底部展示它，让用户知道「我跑的是哪一版」——这是查 changelog 的前提。
const rootPkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
);

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version || '0.0.0'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
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