import type { ElevationRange, TerrainMeta } from './types.js';

/**
 * .r16 格式：裸 Uint16 小端数组，行优先，无文件头。
 *
 * 为什么不带头：头信息全部放 meta.json，同一张图的所有 LOD 与分块共享一份元数据，
 * 避免"改了 meta 忘了改 chunk 头"这类不一致。代价是文件不能单独自解释。
 *
 * 为什么不用 KTX2 R16：KTX2 需要额外容器与超压缩扩展，而这里只需要一个
 * "能按字节偏移随机读"的裸数组。用 fetch + Range 就能只取一个 chunk，够用且零依赖。
 */

const R16_BYTES = 2;

/** 把海拔（米）量化到 [0, 65535]。超出范围的输入会被钳制，不抛错。 */
export function metersToU16(meters: number, range: ElevationRange): number {
  const span = range.maxElevation - range.minElevation;
  if (!(span > 0)) return 0;
  const t = (meters - range.minElevation) / span;
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return Math.round(clamped * 65535);
}

/** 量化值还原为海拔（米）。 */
export function u16ToMeters(value: number, range: ElevationRange): number {
  const span = range.maxElevation - range.minElevation;
  return range.minElevation + (value / 65535) * span;
}

/** 单像素量化误差（米）。用于判断 16bit 是否足够精确。 */
export function quantizationError(range: ElevationRange): number {
  const span = range.maxElevation - range.minElevation;
  return span / 65535;
}

export function r16ByteLength(width: number, height: number): number {
  return width * height * R16_BYTES;
}

/** 编码为小端字节序。浏览器与 Node 都按小端写，保证跨端一致。 */
export function encodeR16(data: Uint16Array): Uint8Array {
  const out = new Uint8Array(data.length * R16_BYTES);
  const view = new DataView(out.buffer);
  for (let i = 0; i < data.length; i += 1) {
    view.setUint16(i * R16_BYTES, data[i] ?? 0, true);
  }
  return out;
}

export function decodeR16(bytes: Uint8Array, expectedLength?: number): Uint16Array {
  if (bytes.byteLength % R16_BYTES !== 0) {
    throw new Error(`[tabby/terrain] .r16 字节数必须是 2 的倍数，实际 ${bytes.byteLength}`);
  }
  const count = bytes.byteLength / R16_BYTES;
  if (expectedLength !== undefined && count !== expectedLength) {
    throw new Error(`[tabby/terrain] .r16 长度不符：期望 ${expectedLength}，实际 ${count}`);
  }
  // 直接对齐到 DataView，避免逐元素判断端序
  const aligned = bytes.byteOffset % R16_BYTES === 0 ? bytes : bytes.slice();
  const view = new DataView(aligned.buffer, aligned.byteOffset, count * R16_BYTES);
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getUint16(i * R16_BYTES, true);
  }
  return out;
}

/** 把整图数据按 step 降采样成低一级 LOD（盒式平均，保留宏观起伏）。 */
export function downsample(data: Uint16Array, width: number, height: number, step: number): Uint16Array {
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
          sum += data[sy * width + sx] ?? 0;
          count += 1;
        }
      }
      out[y * w + x] = count === 0 ? 0 : Math.round(sum / count);
    }
  }
  return out;
}

/** 从 meta 推导量化区间。 */
export function rangeOf(meta: TerrainMeta): ElevationRange {
  return { minElevation: meta.minElevation, maxElevation: meta.maxElevation };
}
