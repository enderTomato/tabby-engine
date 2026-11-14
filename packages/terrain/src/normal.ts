import type { HeightField } from './height-field.js';

/**
 * 法线图（RGBA8）：把法线 xyz 存进 RGB，A 存坡度。
 *
 * 为什么预先烘焙而不是着色器求导：
 * 移动端顶点/片元着色器求导需要 dFdx/dFdy（WebGL2 有，但老驱动精度不稳），
 * 而且每像素多两条采样指令。预烘焙一张图换来着色器里一次 texture 采样。
 *
 * 代价是地形编辑后必须增量重烘焙脏区域，不能靠求导自动跟随。
 */
export function bakeNormals(field: HeightField): Uint8Array {
  const { width, height } = field;
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const n = field.normalAt(col, row);
      const slope = field.slopeAt(col, row);
      const i = (row * width + col) * 4;
      out[i] = Math.round((n[0] * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((n[1] * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((n[2] * 0.5 + 0.5) * 255);
      // 坡度归一到 0..255（0~90°）
      out[i + 3] = Math.round(Math.min(1, slope / (Math.PI / 2)) * 255);
    }
  }
  return out;
}

/** 解码法线图中的一个像素，主要给调试与测试用。 */
export function decodeNormal(rgba: Uint8Array, index: number): { x: number; y: number; z: number; slope: number } {
  const i = index * 4;
  return {
    x: ((rgba[i] ?? 128) / 255) * 2 - 1,
    y: ((rgba[i + 1] ?? 128) / 255) * 2 - 1,
    z: ((rgba[i + 2] ?? 128) / 255) * 2 - 1,
    slope: (rgba[i + 3] ?? 0) / 255 * (Math.PI / 2),
  };
}

/**
 * 流向图（RGBA8）：存归一化的下坡方向，供液体模块少算一遍梯度。
 * R = x 分量，G = z 分量（各映射到 0..255），B = 汇流量占位（当前恒 0），A = 保留。
 *
 * 缺省不生成，因为只有液体模块需要；用 `--flow` 开关打开。
 */
export function bakeFlow(field: HeightField): Uint8Array {
  const { width, height } = field;
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const dx = field.elevationAt(col + 1, row) - field.elevationAt(col - 1, row);
      const dz = field.elevationAt(col, row + 1) - field.elevationAt(col, row - 1);
      // 水往低处流：梯度取反
      let fx = -dx;
      let fz = -dz;
      const len = Math.hypot(fx, fz);
      if (len > 1e-6) {
        fx /= len;
        fz /= len;
      } else {
        fx = 0;
        fz = 0;
      }
      const i = (row * width + col) * 4;
      out[i] = Math.round((fx * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((fz * 0.5 + 0.5) * 255);
      out[i + 2] = 0;
      out[i + 3] = 255;
    }
  }
  return out;
}
