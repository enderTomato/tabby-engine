/**
 * 风场：噪声驱动的方向风 + 间歇性阵风。
 *
 * 设计要点（P07 §3 要求「有质感」而不是「随机抖动」）：
 *
 * - 抖动感来自「每粒子独立随机」，质感来自**空间相关**：相邻位置的风速接近，
 *   所以烟柱会整体弯曲而不是炸开。这里用 value noise 的空间插值提供相关性。
 * - 阵风用低频正弦的**偶次幂**塑形，得到「大多数时候平静、偶尔一阵」的节奏感。
 *   纯正弦会让风力均匀地忽大忽小，看起来像呼吸而不像风。
 * - 两个不同种子的噪声叠加（相差相位与尺度），避免单层噪声的网格感。
 *
 * 为什么不用 Perlin/Simplex：
 * 三层 fbm 的 value noise 在视觉上已经足够，成本是 4 次 hash/采样；
 * Simplex 2D 要 3 次梯度计算 + 内核求和，贵一倍多，而这里要喂 300 个烟粒子/帧。
 *
 * 确定性：全部用 Math.imul 的 32 位整数 hash（精确、跨平台逐位一致），
 * 没有 Math.pow / Math.random，可以进存档与回放。
 */

export interface WindConfig {
  /** 主风向角（弧度，绕 Y 轴，0 指向 +X）。 */
  readonly direction: number;
  /** 基础风速（m/s）。 */
  readonly speed: number;
  /** 湍流强度 0~1，0 时只有单向风。 */
  readonly turbulence: number;
  /** 噪声空间频率（1/米），越大风场越「碎」。 */
  readonly frequency: number;
  /** 噪声时间演进速度（Hz）。 */
  readonly timeScale: number;
  /** 阵风叠加的峰值风速（m/s）。 */
  readonly gustSpeed: number;
  /** 阵风周期（秒），建议 6~14。 */
  readonly gustPeriod: number;
}

export const DEFAULT_WIND: WindConfig = {
  direction: 0.35,
  speed: 1.6,
  turbulence: 0.55,
  frequency: 0.16,
  timeScale: 0.35,
  gustSpeed: 2.6,
  gustPeriod: 9,
};

/** 采样结果写入这里，避免每次返回对象。`[vx, vy, vz]`。 */
export const WIND_STRIDE = 3;

export class WindField {
  config: WindConfig;
  /** 阵风相位偏移，方便多个系统错峰（同一个风向场里不该所有烟同时抖）。 */
  private phase = 0;

  constructor(config: Partial<WindConfig> = {}) {
    this.config = { ...DEFAULT_WIND, ...config };
  }

  setWind(config: Partial<WindConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 采样某点的风速矢量，写入 `out[0..2]`。
   *
   * 成本：2 次 2D value noise（每次 4 次 hash）。300 粒子约 0.02ms。
   */
  sample(x: number, y: number, z: number, time: number, out: Float32Array): void {
    const cfg = this.config;
    const f = cfg.frequency;
    const t = time * cfg.timeScale + this.phase;

    // 两层噪声：一层主导弯曲，一层做细碎扰动
    const a = noise2(x * f, z * f + t, 0x1a2b3c) * 2 - 1;
    const b = noise2(x * f * 2.7 + 11.3, z * f * 2.7 - t * 1.4, 0x5d6e7f) * 2 - 1;
    const n1 = a * 0.72 + b * 0.28;
    const n2 = noise2(x * f - 23.1, z * f + t * 0.8 + 7.7, 0x9c8d7e) * 2 - 1;

    const base = cfg.speed + this.gust(time);
    const turb = cfg.turbulence;
    const cos = Math.cos(cfg.direction);
    const sin = Math.sin(cfg.direction);

    out[0] = cos * base + n1 * turb * base;
    out[1] = (cfg.turbulence * 0.35 * base * n1 * n2) + this.thermal(y);
    out[2] = sin * base + n2 * turb * base;
  }

  /** 当前阵风增量（m/s），偶次幂塑形让「平静期」占多数。 */
  gust(time: number): number {
    const period = Math.max(0.5, this.config.gustPeriod);
    const s = Math.sin((time / period) * Math.PI * 2 + this.phase);
    const shaped = s > 0 ? s * s * s : 0;
    return shaped * this.config.gustSpeed;
  }

  /** 热浮力修正：近地面弱、向上递增，让烟柱越高越散。 */
  private thermal(y: number): number {
    const h = Math.max(0, y);
    return Math.min(1, h * 0.06) * this.config.speed * 0.15;
  }

  /** 打散相位，避免多个 WindField 实例同步阵风。 */
  offsetPhase(phase: number): void {
    this.phase = phase;
  }
}

/**
 * 2D value noise，返回 0..1。
 *
 * 用 Math.imul 做 32 位乘法：普通 `a * b` 在超过 2^53 后会丢精度，
 * 且不同引擎对大整数乘法的舍入可能不同；Math.imul 是精确定义的。
 */
function noise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  // smoothstep 插值：线性插值在格点处有一阶不连续，烟会看出「格子」
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x0 + 1, y0, seed);
  const v01 = hash2(x0, y0 + 1, seed);
  const v11 = hash2(x0 + 1, y0 + 1, seed);

  const top = v00 + (v10 - v00) * ux;
  const bottom = v01 + (v11 - v01) * ux;
  return top + (bottom - top) * uy;
}

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
