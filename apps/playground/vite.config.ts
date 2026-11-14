import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const srcOf = (name: string): string => fileURLToPath(new URL(`../../packages/${name}/src`, import.meta.url));

/**
 * 与 demo 一样：玩法包与 ui 包指到源码。
 * 这里的探针大量直接用 `@tabby/ui`（小地图、旋钮、标签池），
 * 指到源码才能改一行就看到效果，而不是每次先 build。
 */
const aliases = [
  { find: '@tabby/gameplay/defs', replacement: `${srcOf('gameplay')}/defs.ts` },
  { find: '@tabby/gameplay', replacement: `${srcOf('gameplay')}/index.ts` },
  { find: '@tabby/ui', replacement: `${srcOf('ui')}/index.ts` },
];

export default defineConfig({
  base: './',
  resolve: { alias: aliases },
  server: { host: '0.0.0.0', port: 5174, headers: crossOriginIsolationHeaders },
  preview: { host: '0.0.0.0', port: 4174, headers: crossOriginIsolationHeaders },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
