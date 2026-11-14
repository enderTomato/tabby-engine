#!/usr/bin/env node
/**
 * 公开 API 快照。
 *
 * 目的与 api-extractor 的 api report 一致：**任何对公开面的改动都必须显式确认**。
 *
 * 为什么不用 api-extractor：
 * 它捆绑了自己的 TypeScript（7.60 是 6.0.3），与项目用的 5.9 不兼容，
 * 在跟随 extension.ts 的类型 re-export 时直接内部报错（Unable to follow symbol）。
 * 等它跟上 TS 版本再换回来，那之前用这个脚本顶住。
 *
 * 做法：把三个入口的 .d.ts 去掉注释与 sourcemap 行、排序、规范化后整体做哈希。
 * 比「只比导出符号名」严格 —— 加字段、改类型、改默认值都会触发，
 * 这正是 API 报告要抓的东西。
 *
 *   node scripts/api-snapshot.mjs           # 比对，不一致退出 1
 *   node scripts/api-snapshot.mjs --update  # 更新快照（确认改动是有意的之后）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const entries = [
  ['@tabby/physics', 'dist/api/public.d.ts'],
  ['@tabby/physics/extension', 'dist/api/extension.d.ts'],
  ['@tabby/physics/presets', 'dist/api/presets.d.ts'],
];

/** 去掉注释与 sourcemap 注释，压缩空行，保证格式变化不触发误报。 */
function normalize(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/# sourceMappingURL=.*$/gm, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

const sections = [];
const missing = [];
for (const [name, file] of entries) {
  const path = join(root, file);
  if (!existsSync(path)) {
    missing.push(file);
    continue;
  }
  sections.push(`## ${name}\n${normalize(readFileSync(path, 'utf8'))}`);
}

if (missing.length > 0) {
  console.error(`[api-snapshot] 缺少声明文件：${missing.join(', ')}。先执行 pnpm build。`);
  process.exit(2);
}

const surface = sections.join('\n\n');
const hash = createHash('sha256').update(surface).digest('hex').slice(0, 16);
const out = join(root, 'etc', 'api-surface.md');
const header = `<!-- 公开 API 快照。不要手改，用 node scripts/api-snapshot.mjs --update 更新。 -->\n<!-- hash: ${hash} -->\n\n`;
const content = header + surface + '\n';

if (process.argv.includes('--update')) {
  mkdirSync(join(root, 'etc'), { recursive: true });
  writeFileSync(out, content);
  console.log(`[api-snapshot] 已更新，hash=${hash}`);
  process.exit(0);
}

if (!existsSync(out)) {
  console.error('[api-snapshot] 没有基线快照，先跑一次 --update');
  process.exit(2);
}

if (!readFileSync(out, 'utf8').includes(`hash: ${hash}`)) {
  console.error(`[api-snapshot] 公开 API 变了（当前 hash=${hash}）。`);
  console.error('如果是无意的，说明这次改动破坏了对外承诺；如果是有意的，');
  console.error('确认后执行 node scripts/api-snapshot.mjs --update 并把 etc/api-surface.md 一起提交。');
  process.exit(1);
}

console.log(`[api-snapshot] 一致（hash=${hash}）`);
