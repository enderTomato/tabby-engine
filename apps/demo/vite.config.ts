import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
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

const srcOf = (name: string): string => fileURLToPath(new URL(`../../packages/${name}/src`, import.meta.url));

/**
 * 把玩法包与 UI 包指到**源码**而不是 `dist`。
 *
 * 为什么只对这两个包做：它们承载「内置配置表」与「调参面板」，
 * 是开发期真正会被反复改的两处（改数值、加旋钮）。
 * 指到 `dist` 的话，改一行 `defs.ts` 要先 `pnpm -F @tabby/gameplay build`
 * 才看得到效果，而 `import.meta.hot.accept` 也永远收不到更新 ——
 * `game/hmr.ts` 那套「模块一换就把新表推进 ConfigHost」就形同虚设。
 *
 * 其余包（物理、经济、渲染）体积大、改动少，继续走 `dist`，免得每次 dev 冷启动
 * 都要现编一遍 Three 与 Pixi 的入口。
 *
 * 顺序敏感：更长的前缀必须排在前面，否则 `@tabby/gameplay/defs`
 * 会先被 `@tabby/gameplay` 匹配掉，替换成 `.../src/index.ts/defs`。
 */
const aliases = [
  { find: '@tabby/gameplay/defs', replacement: `${srcOf('gameplay')}/defs.ts` },
  { find: '@tabby/gameplay', replacement: `${srcOf('gameplay')}/index.ts` },
  { find: '@tabby/ui', replacement: `${srcOf('ui')}/index.ts` },
];

export default defineConfig({
  plugins: [vue()],
  base: './',
  resolve: { alias: aliases },
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
