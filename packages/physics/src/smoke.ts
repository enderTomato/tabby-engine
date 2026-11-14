import { Rng } from '@tabby/core';
import type { SmokeOptions } from './types.js';

/** renderData 的步长：x, y, z, size, life01, seed。 */
export const SMOKE_STRIDE = 6;

/**
 * 烟雾粒子（纯 CPU，SoA 存储）。
 *
 * 只做「浮力 + 阻尼 + 低频扰动」三件事：
 * 真实涡流（curl noise）在移动端每粒子要 3 次噪声采样，性价比极低，
 * 这里用正弦叠加出可接受的翻卷感，单粒子成本约 15ns。
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
    let i = 0;
    while (i < this.count) {
      const nextAge = (this.age[i] as number) + dt;
      if (nextAge >= life) {
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
        continue;
      }
      this.age[i] = nextAge;

      const s = this.seed[i] as number;
      const wobble = Math.sin(nextAge * 2.3 + s) * 0.5 + Math.cos(nextAge * 1.7 + s * 0.7) * 0.3;
      let vx = (this.vx[i] as number) + wobble * dt;
      let vy = (this.vy[i] as number) + netLift * dt;
      let vz = (this.vz[i] as number) + Math.cos(nextAge * 2.9 + s) * 0.3 * dt;

      const damp = 1 - Math.min(0.95, drag * dt);
      vx *= damp;
      vy *= damp;
      vz *= damp;

      let x = (this.px[i] as number) + vx * dt;
      let y = (this.py[i] as number) + vy * dt;
      let z = (this.pz[i] as number) + vz * dt;

      if (y > bounds.max.y || y < bounds.min.y || x < bounds.min.x || x > bounds.max.x || z < bounds.min.z || z > bounds.max.z) {
        this.count -= 1;
        const last = this.count;
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
