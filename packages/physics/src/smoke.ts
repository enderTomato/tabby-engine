import { Rng } from '@tabby/core';
import type { SmokeOptions } from './types.js';
import { WindField, WIND_STRIDE } from './wind.js';

/** renderData 的步长：x, y, z, size, life01, seed。 */
export const SMOKE_STRIDE = 6;

/**
 * 烟雾粒子（纯 CPU，SoA 存储）。
 *
 * 三件事：浮力上升、阻尼、扰动。
 *
 * 扰动的来源分两级：
 * - **无风场时**用正弦叠加（sine wobble）—— 便宜，但只能做出「原地抖」，
 *   做不出「整柱烟被吹弯」。约 15ns/粒子。
 * - **挂了 WindField 时**改用空间相关噪声 + 阻力拖曳：
 *   加速度 = (风速 - 粒子速) × 耦合系数。相邻粒子的风速接近，
 *   烟柱就整体弯曲而不是炸开，这是「质感」和「随机抖动」的分界线。
 *   成本约 2 次 value noise + 6 次乘加，约 45ns/粒子。
 *
 * 300 粒子挂风场约 0.015ms/帧，相对 8ms 预算可忽略。
 *
 * 软粒子（深度淡出）不在这一层做：它需要读深度缓冲，属于渲染层。
 * 本类只提供 `life01` 与 `size`，由渲染层决定淡出曲线。
 */
export class SmokeSystem {
  readonly capacity: number;
  readonly options: SmokeOptions;
  /** 渲染数据，交错 stride=6，渲染层直接读。 */
  readonly renderData: Float32Array;
  count = 0;

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly age: Float32Array;
  private readonly seed: Float32Array;
  private readonly rng: Rng;

  private wind: WindField | null = null;
  private readonly windBuf = new Float32Array(WIND_STRIDE);
  private windTime = 0;
  /** 风对烟粒子的拖曳强度（1/s）。越大烟越快被风带走。 */
  private windCoupling = 3.2;

  constructor(options: SmokeOptions, seed = 7) {
    this.options = options;
    this.capacity = Math.max(1, Math.floor(options.capacity));
    const c = this.capacity;
    this.renderData = new Float32Array(c * SMOKE_STRIDE);
    this.px = new Float32Array(c);
    this.py = new Float32Array(c);
    this.pz = new Float32Array(c);
    this.vx = new Float32Array(c);
    this.vy = new Float32Array(c);
    this.vz = new Float32Array(c);
    this.age = new Float32Array(c);
    this.seed = new Float32Array(c);
    this.rng = new Rng(seed);
  }

  /**
   * 挂载风场（可复用摆动系统的同一个实例）。
   *
   * 传 null 退回正弦扰动。同一个 WindField 被摆动与烟雾共享时不额外拷贝，
   * 两者读到的是同一时刻的风，烟和旗子的摆动方向才会一致。
   */
  setWind(field: WindField | null, coupling = 3.2): void {
    this.wind = field;
    this.windCoupling = Math.max(0, coupling);
  }

  getWind(): WindField | null {
    return this.wind;
  }

  emit(x: number, y: number, z: number, amount: number, spread: number, upward = 1): number {
    const n = Math.min(Math.floor(amount), this.capacity - this.count);
    for (let k = 0; k < n; k += 1) {
      const i = this.count;
      this.count += 1;
      this.px[i] = x + this.rng.jitter(spread);
      this.py[i] = y + this.rng.jitter(spread * 0.3);
      this.pz[i] = z + this.rng.jitter(spread);
      this.vx[i] = this.rng.jitter(0.4);
      this.vy[i] = upward * this.rng.range(0.6, 1.4);
      this.vz[i] = this.rng.jitter(0.4);
      this.age[i] = 0;
      this.seed[i] = this.rng.next() * 100;
    }
    return n;
  }

  step(dt: number): void {
    const { buoyancy, gravity, drag, life, startSize, endSize, bounds } = this.options;
    const netLift = buoyancy - gravity;
    const wind = this.wind;
    const wb = this.windBuf;
    const coupling = this.windCoupling * dt;
    this.windTime += dt;

    let i = 0;
    while (i < this.count) {
      const nextAge = (this.age[i] as number) + dt;
      if (nextAge >= life) {
        this.swapRemove(i);
        continue;
      }
      this.age[i] = nextAge;

      const s = this.seed[i] as number;
      const wobble = Math.sin(nextAge * 2.3 + s) * 0.5 + Math.cos(nextAge * 1.7 + s * 0.7) * 0.3;
      let vx = (this.vx[i] as number) + wobble * dt;
      let vy = (this.vy[i] as number) + netLift * dt;
      let vz = (this.vz[i] as number) + Math.cos(nextAge * 2.9 + s) * 0.3 * dt;

      if (wind !== null) {
        // 阻力拖曳：风速与时序无关地持续作用，粒子速度向风速收敛
        wind.sample(this.px[i] as number, this.py[i] as number, this.pz[i] as number, this.windTime, wb);
        vx += ((wb[0] as number) - vx) * coupling;
        vy += ((wb[1] as number) - vy) * coupling;
        vz += ((wb[2] as number) - vz) * coupling;
      }

      const damp = 1 - Math.min(0.95, drag * dt);
      vx *= damp;
      vy *= damp;
      vz *= damp;

      const x = (this.px[i] as number) + vx * dt;
      const y = (this.py[i] as number) + vy * dt;
      const z = (this.pz[i] as number) + vz * dt;

      if (y > bounds.max.y || y < bounds.min.y || x < bounds.min.x || x > bounds.max.x || z < bounds.min.z || z > bounds.max.z) {
        this.swapRemove(i);
        continue;
      }

      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      i += 1;
    }
    this.writeOutput(startSize, endSize, life);
  }

  reset(): void {
    this.count = 0;
    this.renderData.fill(0);
    this.windTime = 0;
  }

  /** 尾元素填坑，O(1) 删除。遍历时用 while + 手动递增保证不漏元素。 */
  private swapRemove(i: number): void {
    const last = this.count - 1;
    if (i !== last) {
      this.px[i] = this.px[last] as number;
      this.py[i] = this.py[last] as number;
      this.pz[i] = this.pz[last] as number;
      this.vx[i] = this.vx[last] as number;
      this.vy[i] = this.vy[last] as number;
      this.vz[i] = this.vz[last] as number;
      this.age[i] = this.age[last] as number;
      this.seed[i] = this.seed[last] as number;
    }
    this.count = last;
  }

  private writeOutput(startSize: number, endSize: number, life: number): void {
    const out = this.renderData;
    for (let i = 0; i < this.count; i += 1) {
      const t = (this.age[i] as number) / life;
      const o = i * SMOKE_STRIDE;
      out[o] = this.px[i] as number;
      out[o + 1] = this.py[i] as number;
      out[o + 2] = this.pz[i] as number;
      out[o + 3] = startSize + (endSize - startSize) * t;
      out[o + 4] = t;
      out[o + 5] = this.seed[i] as number;
    }
  }
}
