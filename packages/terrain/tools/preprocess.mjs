#!/usr/bin/env node
// 地形高程预处理 CLI —— 必须在 Node 侧跑，不能进浏览器。
//
// 用法：
//   node tools/preprocess.mjs <输入文件> --out <输出目录> [选项]
//
// 示例：
//   node tools/preprocess.mjs ./data/terrain16.png --out ./public/terrain \
//     --format png-16bit --min-elev 0 --max-elev 3200 \
//     --cell-size 30 --sea-level 0 --chunk 128 --lod 0,1,2 --flow
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { decodePngHeight } from './lib/png-decode.mjs';
import { decodeHgt } from './lib/hgt-decode.mjs';
import { decodeAsc } from './lib/asc-decode.mjs';

const TOOL_VERSION = 'terrain-tools 0.1.0';

const USAGE = `用法: node tools/preprocess.mjs <输入文件> --out <目录> [选项]

必填:
  --out <dir>            输出目录（会被清空重建）

可选:
  --format <f>           png-16bit | png-8bit | srtm-hgt | ascii-grid（缺省按扩展名推断）
  --min-elev <m>         PNG 的高度映射下限（米）；8bit 必填
  --max-elev <m>         PNG 的高度映射上限（米）
  --sea-level <m>        海平面基准，默认 0
  --cell-size <m>        单格水平距离（米），默认 30
  --vertical-scale <f>   渲染垂直夸张，默认 1
  --chunk <n>            分块边长，默认 128
  --lod <a,b,c>          LOD 采样步长序列，默认 0,1,2（0 表示原图）
  --flow                 额外生成流向图
  --bbox <w,s,e,n>       经纬度范围，用于 equirect 投影元数据
  --license-source <s>   数据源名称
  --license-url <u>      数据源地址
  --attribution <t>      署名文本
  --quiet                只输出错误
`;

function parseArgs(argv) {
  const args = { lod: '0,1,2', chunk: 128, 'cell-size': 30, 'sea-level': 0, 'vertical-scale': 1, quiet: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === 'flow') { args.flow = true; continue; }
    if (key === 'quiet') { args.quiet = true; continue; }
    if (key === 'help') { console.log(USAGE); process.exit(0); }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 --${key} 缺少值`);
    args[key] = value;
    i += 1;
  }
  args.input = positional[0];
  return args;
}

function inferFormat(file, explicit) {
  if (explicit !== undefined) return explicit;
  const ext = extname(file).toLowerCase();
  if (ext === '.hgt') return 'srtm-hgt';
  if (ext === '.asc') return 'ascii-grid';
  if (ext === '.png') return 'png-16bit'; // 由实际 bitDepth 修正
  throw new Error(`无法从扩展名 ${ext} 推断格式，请用 --format 指定`);
}

/** 读源文件，统一成 { width, height, meters:Float32Array, isMeters } */
function loadSource(args) {
  const format = inferFormat(args.input, args.format);
  const raw = readFileSync(args.input);

  if (format === 'png-16bit' || format === 'png-8bit') {
    const png = decodePngHeight(raw);
    const minElev = Number(args['min-elev']);
    const maxElev = Number(args['max-elev']);
    if (!Number.isFinite(minElev) || !Number.isFinite(maxElev)) {
      throw new Error('PNG 输入必须提供 --min-elev 与 --max-elev（像素值本身没有米制含义）');
    }
    if (maxElev <= minElev) throw new Error('--max-elev 必须大于 --min-elev');
    if (png.bitDepth === 8) {
      console.warn('[warn] 输入是 8bit，量化误差约 ' + ((maxElev - minElev) / 255).toFixed(1) + 'm；高度图建议用 16bit');
    }
    const meters = new Float32Array(png.values.length);
    for (let i = 0; i < png.values.length; i += 1) {
      meters[i] = minElev + png.values[i] * (maxElev - minElev);
    }
    return { width: png.width, height: png.height, meters, bitDepth: png.bitDepth, format };
  }

  if (format === 'srtm-hgt') {
    const hgt = decodeHgt(raw);
    const base = new Float32Array(hgt.heights.length);
    for (let i = 0; i < hgt.heights.length; i += 1) base[i] = hgt.heights[i];
    const { meters, filled } = fillVoids(base, hgt.width, hgt.height);
    if (filled > 0) {
      console.warn(`[warn] .hgt 有 ${filled} 个 void 值（-32768），已用邻域均值填补`);
    }
    return { width: hgt.width, height: hgt.height, meters, bitDepth: 16, format };
  }

  const asc = decodeAsc(raw.toString('utf8'));
  const meters = new Float32Array(asc.heights);
  if (Number(args['cell-size']) === 30 && asc.cellSizeMeters !== 1) {
    args['cell-size'] = String(asc.cellSizeMeters);
  }
  return { width: asc.width, height: asc.height, meters, bitDepth: 16, format };
}

/** SRTM 的 void（-32768）不是高程，必须填补，否则会把量化区间拉到 -32768~最高峰，真实地形被压扁。 */
function fillVoids(meters, width, height) {
  const VOID = -32768;
  const out = Float32Array.from(meters);
  const pending = [];
  for (let i = 0; i < out.length; i += 1) if (out[i] === VOID) pending.push(i);
  if (pending.length === 0) return { meters: out, filled: 0 };

  let remaining = pending;
  for (let pass = 0; pass < 6 && remaining.length > 0; pass += 1) {
    const next = [];
    for (const index of remaining) {
      const c = index % width;
      const r = (index - c) / width;
      let sum = 0;
      let count = 0;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nc >= width || nr < 0 || nr >= height) continue;
        const v = out[nr * width + nc];
        if (v === VOID) continue;
        sum += v;
        count += 1;
      }
      if (count > 0) out[index] = sum / count;
      else next.push(index);
    }
    remaining = next;
  }
  // 整片无数据的孤立区域，填 0（之后由人工确认为水面或平地）
  for (const index of remaining) out[index] = 0;
  return { meters: out, filled: pending.length };
}

function boundsOf(meters) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < meters.length; i += 1) {
    const v = meters[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

function quantize(meters, min, max) {
  const span = max - min;
  const out = new Uint16Array(meters.length);
  for (let i = 0; i < meters.length; i += 1) {
    const t = span > 0 ? (meters[i] - min) / span : 0;
    out[i] = Math.round((t <= 0 ? 0 : t >= 1 ? 1 : t) * 65535);
  }
  return out;
}

function toR16(data) {
  const out = Buffer.alloc(data.length * 2);
  for (let i = 0; i < data.length; i += 1) out.writeUInt16LE(data[i], i * 2);
  return out;
}

/** 盒式降采样，与 packages/terrain/src/r16.ts 的 downsample 保持一致。 */
function downsample(data, width, height, step) {
  const w = Math.max(1, Math.floor(width / step));
  const h = Math.max(1, Math.floor(height / step));
  const out = new Uint16Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = 0; dy < step; dy += 1) {
        const sy = y * step + dy;
        if (sy >= height) break;
        for (let dx = 0; dx < step; dx += 1) {
          const sx = x * step + dx;
          if (sx >= width) break;
          sum += data[sy * width + sx];
          count += 1;
        }
      }
      out[y * w + x] = count === 0 ? 0 : Math.round(sum / count);
    }
  }
  return { data: out, width: w, height: h };
}

/** 法线图，与 packages/terrain/src/normal.ts 的 bakeNormals 算法一致。 */
function bakeNormals(quantized, width, height, min, max, cellSize) {
  const span = max - min;
  const elev = (c, r) => {
    const cc = c < 0 ? 0 : c >= width ? width - 1 : c;
    const rr = r < 0 ? 0 : r >= height ? height - 1 : r;
    return min + (quantized[rr * width + cc] / 65535) * span;
  };
  const out = Buffer.alloc(width * height * 4);
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const dx = (elev(c + 1, r) - elev(c - 1, r)) / (2 * cellSize);
      const dz = (elev(c, r + 1) - elev(c, r - 1)) / (2 * cellSize);
      const nx = -dx;
      const nz = -dz;
      const len = Math.hypot(nx, 1, nz);
      const i = (r * width + c) * 4;
      out[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
      const slope = Math.atan(Math.hypot(dx, dz));
      out[i + 3] = Math.round(Math.min(1, slope / (Math.PI / 2)) * 255);
    }
  }
  return out;
}

function bakeFlow(quantized, width, height, min, max, cellSize) {
  const span = max - min;
  const elev = (c, r) => {
    const cc = c < 0 ? 0 : c >= width ? width - 1 : c;
    const rr = r < 0 ? 0 : r >= height ? height - 1 : r;
    return min + (quantized[rr * width + cc] / 65535) * span;
  };
  const out = Buffer.alloc(width * height * 4);
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      let fx = -(elev(c + 1, r) - elev(c - 1, r));
      let fz = -(elev(c, r + 1) - elev(c, r - 1));
      const len = Math.hypot(fx, fz);
      if (len > 1e-9) { fx /= len; fz /= len; } else { fx = 0; fz = 0; }
      const i = (r * width + c) * 4;
      out[i] = Math.round((fx * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((fz * 0.5 + 0.5) * 255);
      out[i + 2] = 0;
      out[i + 3] = 255;
    }
  }
  return out;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.input === undefined || args.out === undefined) {
    console.error(USAGE);
    process.exit(1);
  }

  const t0 = Date.now();
  const outDir = resolve(args.out);
  const source = loadSource(args);
  const bounds = boundsOf(source.meters);
  const minElev = Number(args['min-elev'] ?? bounds.min);
  const maxElev = Number(args['max-elev'] ?? bounds.max);
  const cellSize = Number(args['cell-size']);
  const seaLevel = Number(args['sea-level']);
  const verticalScale = Number(args['vertical-scale']);
  const chunkSize = Math.max(8, Math.floor(Number(args.chunk)));
  // --lod 传的是「级别编号」，采样步长 = 2^level，避免调用方还要自己算幂次
  const levels = [...new Set(String(args.lod).split(',').map((s) => Math.floor(Number(s))).filter(Number.isFinite))]
    .filter((n) => n >= 0)
    .sort((a, b) => a - b);
  if (levels.length === 0 || levels[0] !== 0) levels.unshift(0);
  const lodPlans = levels.map((level) => ({ level, step: 2 ** level }));

  if (!args.quiet) {
    console.log(`源文件     ${basename(args.input)}  ${source.width}×${source.height}  ${source.format}/${source.bitDepth}bit`);
    console.log(`高程范围   ${bounds.min.toFixed(1)} ~ ${bounds.max.toFixed(1)} m（量化区间 ${minElev} ~ ${maxElev}）`);
    console.log(`量化误差   ±${((maxElev - minElev) / 65535 / 2).toFixed(3)} m`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const quantized = quantize(source.meters, minElev, maxElev);

  // LOD0 分块
  const chunksX = Math.ceil(source.width / chunkSize);
  const chunksY = Math.ceil(source.height / chunkSize);
  let chunkBytes = 0;
  for (let cy = 0; cy < chunksY; cy += 1) {
    for (let cx = 0; cx < chunksX; cx += 1) {
      const tile = new Uint16Array(chunkSize * chunkSize);
      for (let y = 0; y < chunkSize; y += 1) {
        const srcRow = Math.min(cy * chunkSize + y, source.height - 1);
        for (let x = 0; x < chunkSize; x += 1) {
          const srcCol = Math.min(cx * chunkSize + x, source.width - 1);
          tile[y * chunkSize + x] = quantized[srcRow * source.width + srcCol];
        }
      }
      const buf = toR16(tile);
      const dir = join(outDir, 'chunks', '0');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${cx}_${cy}.r16`), buf);
      chunkBytes += buf.length;
    }
  }

  // 低阶 LOD 整图
  const lods = [{ level: 0, step: 1, width: source.width, height: source.height }];
  let lodBytes = 0;
  for (const plan of lodPlans) {
    if (plan.level === 0) continue;
    const ds = downsample(quantized, source.width, source.height, plan.step);
    const rel = `lods/${plan.level}/height.r16`;
    mkdirSync(join(outDir, dirname(rel)), { recursive: true });
    const buf = toR16(ds.data);
    writeFileSync(join(outDir, rel), buf);
    lodBytes += buf.length;
    lods.push({ level: plan.level, step: plan.step, width: ds.width, height: ds.height, file: rel });
  }

  // 派生图
  const normalBuf = bakeNormals(quantized, source.width, source.height, minElev, maxElev, cellSize);
  writeFileSync(join(outDir, 'normal.rgba8'), normalBuf);
  let flowFile = null;
  if (args.flow) {
    writeFileSync(join(outDir, 'flow.rgba8'), bakeFlow(quantized, source.width, source.height, minElev, maxElev, cellSize));
    flowFile = 'flow.rgba8';
  }

  const bboxArg = args.bbox;
  const projection = bboxArg !== undefined
    ? { type: 'equirect', bbox: bboxArg.split(',').map(Number) }
    : { type: 'local', metersPerUnit: 1 };

  const meta = {
    version: 1,
    width: source.width,
    height: source.height,
    cellSizeMeters: cellSize,
    minElevation: minElev,
    maxElevation: maxElev,
    seaLevel,
    verticalScale,
    projection,
    license: {
      source: args['license-source'] ?? 'unspecified',
      url: args['license-url'] ?? '',
      attribution: args.attribution ?? '数据来源未标注',
      redistribution: 'attribution',
    },
    lods,
    chunks: { chunkSize, chunksX, chunksY, pathTemplate: 'chunks/{lod}/{x}_{y}.r16' },
    normalFile: 'normal.rgba8',
    flowFile,
    generator: TOOL_VERSION,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

  if (!args.quiet) {
    const total = chunkBytes + lodBytes + normalBuf.length + (flowFile ? source.width * source.height * 4 : 0);
    console.log(`分块       ${chunksX}×${chunksY} = ${chunksX * chunksY} 个（${chunkSize}×${chunkSize}） ${fmtBytes(chunkBytes)}`);
    console.log(`LOD        ${lods.map((l) => `${l.width}×${l.height}`).join(' / ')} ${fmtBytes(lodBytes)}`);
    console.log(`法线图     ${source.width}×${source.height} ${fmtBytes(normalBuf.length)}`);
    if (flowFile !== null) console.log(`流向图     已生成`);
    console.log(`总产物     ${fmtBytes(total)}  耗时 ${Date.now() - t0}ms`);
    console.log(`输出       ${outDir}`);
  }
}

main().catch((err) => {
  console.error(`[error] ${err.message}`);
  process.exit(1);
});
