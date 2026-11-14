#!/usr/bin/env node
/**
 * 把 three 自带的解码器拷进应用的 `public/decoders/`。
 *
 * ## 为什么这不进构建产物
 *
 * `basis_transcoder`（578KB）与 `draco_decoder`（340KB）合计约 900KB。
 * 打进主包意味着「只想画几个方块」的游戏也要先下 1MB。所以它们走
 * **运行时按需 fetch**，由部署方托管 —— 这个脚本只是帮你从 node_modules 搬过去。
 *
 * ## 为什么带上 LICENSE
 *
 * basis_universal 与 draco 都是 Apache-2.0，再分发必须附许可与出处。
 * 拷贝时不带 LICENSE 是最常见的合规事故，所以这里强制一起拷。
 *
 * ## 为什么默认不拷 `draco_decoder.js`
 *
 * 那是 DRACOLoader 的 asm.js 回退，719KB。我们的 `createDraco()` 显式写死
 * `setDecoderConfig({ type: 'wasm' })` —— 没有 wasm 的设备直接走「未压缩网格」
 * 候选，不在这里降级到 asm.js。拷了它等于在磁盘上放一个永远不会被 fetch 的文件。
 * 确实需要回退时用 `--with-js-fallback` 打开。
 *
 * 用法：`node tools/copy-decoders.mjs [目标目录] [--with-js-fallback]`
 */

import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 第一个位置参数才是目标目录，`--with-js-fallback` 可能出现在任意位置
const outDir = resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? join(root, 'apps/playground/public/decoders'));
const withJsFallback = process.argv.includes('--with-js-fallback');
const libs = join(root, 'packages/render3d/node_modules/three/examples/jsm/libs');

if (!existsSync(libs)) {
  console.error(`找不到 three 的解码器目录：${libs}`);
  console.error('先在 packages/render3d 下跑 pnpm install');
  process.exit(1);
}

const files = [
  [join(libs, 'basis/basis_transcoder.js'), 'basis_transcoder.js'],
  [join(libs, 'basis/basis_transcoder.wasm'), 'basis_transcoder.wasm'],
  [join(libs, 'draco/draco_decoder.wasm'), 'draco_decoder.wasm'],
  [join(libs, 'draco/draco_wasm_wrapper.js'), 'draco_wasm_wrapper.js'],
];
if (withJsFallback) files.push([join(libs, 'draco/draco_decoder.js'), 'draco_decoder.js']);

mkdirSync(outDir, { recursive: true });
for (const [from, name] of files) {
  if (!existsSync(from)) {
    console.warn(`跳过（不存在）：${from}`);
    continue;
  }
  copyFileSync(from, join(outDir, name));
  console.log(`${name}  ${(readFileSync(join(outDir, name)).length / 1024).toFixed(0)}KB`);
}

writeFileSync(
  join(outDir, 'README.md'),
  [
    '# 解码器（按需加载）',
    '',
    '这些文件来自 three.js 的 `examples/jsm/libs/`，由 `tools/copy-decoders.mjs` 拷贝。',
    '',
    '| 文件 | 来源 | 许可 |',
    '| --- | --- | --- |',
    '| `basis_transcoder.*` | [basis_universal](https://github.com/BinomialLLC/basis_universal) | Apache-2.0 |',
    '| `draco_decoder.wasm` / `draco_wasm_wrapper.js` | [draco](https://github.com/google/draco) | Apache-2.0 |',
    '',
    '`draco_decoder.js`（asm.js 回退，719KB）默认**不拷**：加载器写死了 `type: \'wasm\'`，',
    '没有 wasm 的设备改走「未压缩网格」候选。要回退请加 `--with-js-fallback` 重跑脚本。',
    '',
    '再分发时请保留上游 LICENSE。它们**不在**主包里，只在真正加载 KTX2 / DRACO 资源时按需 fetch。',
    '',
  ].join('\n'),
);
console.log(`\n输出目录：${outDir}`);
