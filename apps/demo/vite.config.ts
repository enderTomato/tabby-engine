import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * COOP/COEP 是 SharedArrayBuffer 的硬前提。
 * dev / preview 都在这里下发；生产部署见 docs/ANDROID-DEPLOY.md 的 Nginx 与 Capacitor 配置。
 */
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  plugins: [vue()],
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    headers: crossOriginIsolationHeaders,
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
