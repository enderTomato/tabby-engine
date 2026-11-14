import { decodeR16, rangeOf, u16ToMeters } from './r16.js';
import type { ElevationRange, SampleOptions, TerrainMeta } from './types.js';

/**
 * 高度场：一张已解码的高程栅格，提供采样与派生查询。
 *
 * 坐标系约定（与 types.ts 一致）：
 * - 世界平面坐标 (x, z)，单位米；**原点在栅格西北角**；
 * - x 向东递增，z 向南递增；
 * - 栅格 col = x / cellSize，row = z / cellSize，row 0 是最北一行。
 *
 * 为什么不用经纬度做运行时坐标：模拟经营的商品流、寻路、碰撞全是米制平面运算，
 * 经纬度会在每一步引入球面几何。投影只在离线预处理时做一次，运行时只见米。
 */
export class HeightField {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  readonly range: ElevationRange;
  readonly data: Uint16Array;

  constructor(data: Uint16Array, width: number, height: number, cellSize: number, range: ElevationRange) {
    if (data.length !== width * height) {
      throw new Error(`[tabby/terrain] 数据长度 ${data.length} 与 ${width}×${height} 不匹配`);
    }
    this.data = data;
    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.range = range;
  }

  static fromMeta(bytes: Uint8Array, meta: TerrainMeta): HeightField {
    const data = decodeR16(bytes, meta.width * meta.height);
    return new HeightField(data, meta.width, meta.height, meta.cellSizeMeters, rangeOf(meta));
  }

  /** 整图的世界跨度（米）。 */
  get worldWidth(): number {
    return (this.width - 1) * this.cellSize;
  }

  get worldHeight(): number {
    return (this.height - 1) * this.cellSize;
  }

  /** 栅格值（量化）→ 米。 */
  elevationAt(col: number, row: number): number {
    const c = col < 0 ? 0 : col >= this.width ? this.width - 1 : col;
    const r = row < 0 ? 0 : row >= this.height ? this.height - 1 : row;
    return u16ToMeters(this.data[r * this.width + c] ?? 0, this.range);
  }

  /**
   * 双线性采样（米）。
   * 地形物理、可建性判定、液体溢流都要用这个，不要用最近邻——最近邻会让坡面呈阶梯。
   */
  sampleWorld(x: number, z: number, options: SampleOptions = {}): number {
    const fx = x / this.cellSize;
    const fz = z / this.cellSize;
    const outside = options.outside ?? this.range.minElevation;

    if (fx < 0 || fz < 0 || fx > this.width - 1 || fz > this.height - 1) {
      if (options.outside !== undefined) return outside;
      // 无显式越界值时做边缘钳制，避免把地图边缘的缓冲区误判成悬崖
      return this.sampleClamped(fx, fz);
    }
    return this.interpolate(fx, fz);
  }

  private sampleClamped(fx: number, fz: number): number {
    const cx = fx < 0 ? 0 : fx > this.width - 1 ? this.width - 1 : fx;
    const cz = fz < 0 ? 0 : fz > this.height - 1 ? this.height - 1 : fz;
    return this.interpolate(cx, cz);
  }

  private interpolate(fx: number, fz: number): number {
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const x1 = Math.min(x0 + 1, this.width - 1);
    const z1 = Math.min(z0 + 1, this.height - 1);
    const tx = fx - x0;
    const tz = fz - z0;

    const h00 = this.elevationAt(x0, z0);
    const h10 = this.elevationAt(x1, z0);
    const h01 = this.elevationAt(x0, z1);
    const h11 = this.elevationAt(x1, z1);

    const top = h00 + (h10 - h00) * tx;
    const bottom = h01 + (h11 - h01) * tx;
    return top + (bottom - top) * tz;
  }

  /** 坡度（弧度），0 为水平。用中心差分，边缘退化为单侧差分。 */
  slopeAt(col: number, row: number): number {
    const dx = (this.elevationAt(col + 1, row) - this.elevationAt(col - 1, row)) / (2 * this.cellSize);
    const dz = (this.elevationAt(col, row + 1) - this.elevationAt(col, row - 1)) / (2 * this.cellSize);
    return Math.atan(Math.hypot(dx, dz));
  }

  /** 单位法线（x, y, z），y 向上。 */
  normalAt(col: number, row: number): readonly [number, number, number] {
    const dx = (this.elevationAt(col + 1, row) - this.elevationAt(col - 1, row)) / (2 * this.cellSize);
    const dz = (this.elevationAt(col, row + 1) - this.elevationAt(col, row - 1)) / (2 * this.cellSize);
    const nx = -dx;
    const nz = -dz;
    const len = Math.hypot(nx, 1, nz);
    return [nx / len, 1 / len, nz / len];
  }

  /** 是否低于海平面判定线（默认用 meta 的 seaLevel）。 */
  isUnderwater(col: number, row: number, seaLevel: number): boolean {
    return this.elevationAt(col, row) < seaLevel;
  }

  /** 单点坡度是否可建设（默认 25°）。 */
  isBuildable(col: number, row: number, maxSlopeRad = (25 * Math.PI) / 180): boolean {
    return this.slopeAt(col, row) <= maxSlopeRad;
  }
}
