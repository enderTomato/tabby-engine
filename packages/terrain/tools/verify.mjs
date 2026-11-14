#!/usr/bin/env node
// T07 回归测试：预处理产物 → 加载器 → 采样，全链路数值断言。
// 用法：node tools/verify.mjs [产物目录] [源PNG]
// 退出码非 0 表示有断言失败，可直接进 CI。
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TerrainLoader, HeightField, bakeNormals, metersToU16, u16ToMeters } from '../dist/index.js';
import { decodePngHeight } from './lib/png-decode.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? join(here, '.tmp', 'out');
const srcPng = process.argv[3] ?? join(here, '.tmp', 'terrain16.png');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures += 1;
}

// 1) 单元级：量化往返
{
  const range = { minElevation: -100, maxElevation: 3000 };
  let worst = 0;
  for (const v of [-100, 0, 123.456, 1500, 2999.9, 3000]) {
    const back = u16ToMeters(metersToU16(v, range), range);
    worst = Math.max(worst, Math.abs(back - v));
  }
  check('量化往返误差', worst < 0.03, `max ${worst.toFixed(4)}m`);
}

// 2) 产物完整性
if (!existsSync(join(outDir, 'meta.json'))) {
  console.error(`[error] 产物不存在：${outDir}\n先跑 preprocess.mjs`);
  process.exit(1);
}

const loader = new TerrainLoader({
  baseUrl: 'file://' + outDir,
  fetchImpl: async (url) => {
    const path = url.replace('file://', '');
    try {
      const buf = readFileSync(path);
      return { ok: true, status: 200, arrayBuffer: async () => buf, json: async () => JSON.parse(buf.toString('utf8')) };
    } catch {
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) };
    }
  },
});

const meta = await loader.loadMeta();
check('meta 版本', meta.version === 1, `v${meta.version}`);
check('meta 尺寸', meta.width > 0 && meta.height > 0, `${meta.width}×${meta.height}`);

const field = await loader.loadAll();
check('整图拼装尺寸', field.width === meta.width && field.height === meta.height);
check('分块缓存命中', meta.chunks === null || loader.cachedChunks === meta.chunks.chunksX * meta.chunks.chunksY,
  `${loader.cachedChunks} 块`);

// 3) 与源图逐点比对（只有提供 PNG 源时才跑）
if (existsSync(srcPng)) {
  const src = decodePngHeight(readFileSync(srcPng));
  const span = meta.maxElevation - meta.minElevation;
  let maxErr = 0;
  const stepCols = Math.max(1, Math.floor(meta.width / 64));
  for (let r = 0; r < Math.min(src.height, meta.height); r += stepCols) {
    for (let c = 0; c < Math.min(src.width, meta.width); c += stepCols) {
      const expect = meta.minElevation + src.values[r * src.width + c] * span;
      maxErr = Math.max(maxErr, Math.abs(expect - field.elevationAt(c, r)));
    }
  }
  const limit = span / 65535 + 1e-6;
  check('16bit 还原精度', maxErr <= limit, `max ${maxErr.toFixed(4)}m ≤ 量化上限 ${limit.toFixed(4)}m`);
}

// 4) 双线性插值：中心点应等于四角均值
{
  const c = Math.floor(field.width / 2);
  const r = Math.floor(field.height / 2);
  const mid = field.sampleWorld(c * field.cellSize + field.cellSize / 2, r * field.cellSize + field.cellSize / 2);
  const avg = (field.elevationAt(c, r) + field.elevationAt(c + 1, r) + field.elevationAt(c, r + 1) + field.elevationAt(c + 1, r + 1)) / 4;
  check('双线性插值对称性', Math.abs(mid - avg) < 0.01, `差 ${Math.abs(mid - avg).toFixed(4)}m`);
}

// 5) 越界行为
{
  const outside = field.sampleWorld(-9999, -9999, { outside: -1 });
  check('越界返回 outside 值', outside === -1);
  const clamped = field.sampleWorld(-9999, -9999);
  check('越界默认边缘钳制', Number.isFinite(clamped));
}

// 6) 法线：必须归一化，且 y > 0
{
  const n = field.normalAt(10, 10);
  const len = Math.hypot(n[0], n[1], n[2]);
  check('法线归一化', Math.abs(len - 1) < 1e-6, `len=${len.toFixed(6)}`);
  check('法线朝上', n[1] > 0);
}

// 7) 法线图与运行时烘焙一致（工具与运行时不漂移）
{
  const expected = bakeNormals(field);
  const actual = readFileSync(join(outDir, 'normal.rgba8'));
  let bad = 0;
  for (let i = 0; i < expected.length; i += 101) {
    if (Math.abs(expected[i] - actual[i]) > 1) bad += 1;
  }
  check('法线图与运行时烘焙一致', bad === 0, `抽样差异 ${bad}`);
}

// 8) LOD 链：尺寸递减、峰值不超原图
{
  let prev = field.width;
  let ok = true;
  for (const lod of meta.lods) {
    if (lod.level === 0) continue;
    const l = new TerrainLoader({ baseUrl: 'file://' + outDir, lod: lod.level, fetchImpl: loader.fetchImpl });
    const lf = await l.loadAll();
    if (!(lf.width < prev)) ok = false;
    const peak = Math.max(...lf.data);
    if (peak > Math.max(...field.data) * 1.001) ok = false;
    prev = lf.width;
  }
  check('LOD 链尺寸与峰值单调', ok);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
