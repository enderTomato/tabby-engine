import { Rng } from '@tabby/core';
import type { FluidOptions, FluidStats, Obstacle } from './types.js';

/** 单粒子邻居上限（防极端聚集把内存打爆，超出部分丢弃最远邻居）。 */
const MAX_NEIGHBORS = 40;

/**
 * SPH-lite 流体（Position Based Fluids，Macklin & Müller 2013 简化版）。
 *
 * 为什么选 CPU + PBF 而不是 GPU 平流：
 * - 类《天际线》的水只要求「能看懂在流动 + 不炸」，不要求真实；
 * - PBF 用密度约束替代硬弹簧，可在 2~3 次迭代内稳定，低端机也能跑 600 粒子；
 * - 数值全在 Float32Array 里，天然适配 SAB 零拷贝与 Worker 迁移；
 * - 不依赖浮点纹理，规避 Mali-4xx / PowerVR 的采样坑。
 *
 * 复杂度：邻居搜索用均匀网格 + 计数排序，O(n·k)，k 为平均邻居数（约 12~18）。
 */
export class FluidSolver {
  readonly capacity: number;
  readonly options: FluidOptions;
  /** 交错 xyz 的输出缓冲，渲染层直接读，不产生每帧分配。 */
  readonly positions: Float32Array;
  count = 0;

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly preX: Float32Array;
  private readonly preY: Float32Array;
  private readonly preZ: Float32Array;
  private readonly lambda: Float32Array;
  private readonly density: Float32Array;
  private readonly cellOf: Int32Array;
  private readonly cellStart: Int32Array;
  private readonly cellCursor: Int32Array;
  private readonly cellEntries: Int32Array;
  private readonly neighborStart: Int32Array;
  private readonly neighborList: Int32Array;

  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly cellCount: number;
  private readonly h: number;
  private readonly h2: number;
  private readonly poly6: number;
  private readonly spikyGrad: number;
  private readonly rng: Rng;

  private lastStepMs = 0;
  private avgNeighbors = 0;
  private maxDensityError = 0;

  constructor(options: FluidOptions, seed = 1) {
    this.options = options;
    this.capacity = Math.max(1, Math.floor(options.capacity));
    const h = Math.max(0.1, options.smoothingRadius);
    this.h = h;
    this.h2 = h * h;
    this.poly6 = 315 / (64 * Math.PI * h ** 9);
    this.spikyGrad = -45 / (Math.PI * h ** 6);
    this.rng = new Rng(seed);

    const { min, max } = options.bounds;
    this.nx = Math.max(1, Math.ceil((max.x - min.x) / h));
    this.ny = Math.max(1, Math.ceil((max.y - min.y) / h));
    this.nz = Math.max(1, Math.ceil((max.z - min.z) / h));
    this.cellCount = this.nx * this.ny * this.nz;
    if (this.cellCount > 400_000) {
      throw new Error(
        `[tabby/physics] 流体网格过大 (${this.cellCount} cells)，请增大 smoothingRadius 或缩小 bounds`,
      );
    }

    const c = this.capacity;
    this.positions = new Float32Array(c * 3);
    this.px = new Float32Array(c);
    this.py = new Float32Array(c);
    this.pz = new Float32Array(c);
    this.vx = new Float32Array(c);
    this.vy = new Float32Array(c);
    this.vz = new Float32Array(c);
    this.preX = new Float32Array(c);
    this.preY = new Float32Array(c);
    this.preZ = new Float32Array(c);
    this.lambda = new Float32Array(c);
    this.density = new Float32Array(c);
    this.cellOf = new Int32Array(c);
    this.cellStart = new Int32Array(this.cellCount + 1);
    this.cellCursor = new Int32Array(this.cellCount);
    this.cellEntries = new Int32Array(c);
    this.neighborStart = new Int32Array(c + 1);
    this.neighborList = new Int32Array(c * MAX_NEIGHBORS);
  }

  /** 在世界坐标处撒入粒子，返回实际生成数量（容量不足时会被截断）。 */
  spawn(
    amount: number,
    centerX: number,
    centerY: number,
    centerZ: number,
    spreadX: number,
    spreadY: number,
    spreadZ: number,
  ): number {
    const n = Math.min(amount, this.capacity - this.count);
    for (let k = 0; k < n; k += 1) {
      const i = this.count;
      this.count += 1;
      const x = centerX + this.rng.jitter(spreadX);
      const y = centerY + this.rng.jitter(spreadY);
      const z = centerZ + this.rng.jitter(spreadZ);
      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.preX[i] = x;
      this.preY[i] = y;
      this.preZ[i] = z;
      this.vx[i] = 0;
      this.vy[i] = 0;
      this.vz[i] = 0;
    }
    return n;
  }

  /** 移除单个粒子（swap-remove，顺序不保证）。 */
  despawn(index: number): void {
    if (index < 0 || index >= this.count) return;
    const last = this.count - 1;
    if (index !== last) {
      this.px[index] = this.px[last] as number;
      this.py[index] = this.py[last] as number;
      this.pz[index] = this.pz[last] as number;
      this.vx[index] = this.vx[last] as number;
      this.vy[index] = this.vy[last] as number;
      this.vz[index] = this.vz[last] as number;
      this.preX[index] = this.preX[last] as number;
      this.preY[index] = this.preY[last] as number;
      this.preZ[index] = this.preZ[last] as number;
    }
    this.count = last;
  }

  reset(): void {
    this.count = 0;
  }

  step(dt: number, obstacles: readonly Obstacle[] = []): void {
    const t0 = now();
    if (this.count === 0) {
      this.lastStepMs = now() - t0;
      return;
    }
    this.predict(dt);
    this.buildGrid();
    this.buildNeighbors();
    this.solveDensity(dt);
    this.applyViscosity(dt);
    this.integrateAndCollide(dt, obstacles);
    this.writeOutput();
    this.lastStepMs = now() - t0;
  }

  getStats(): FluidStats {
    return {
      count: this.count,
      capacity: this.capacity,
      gridCells: this.cellCount,
      avgNeighbors: this.avgNeighbors,
      maxDensityError: this.maxDensityError,
      stepMs: this.lastStepMs,
    };
  }

  private predict(dt: number): void {
    const g = this.options.gravity;
    const maxSpeed = this.options.maxSpeed;
    for (let i = 0; i < this.count; i += 1) {
      this.preX[i] = this.px[i] as number;
      this.preY[i] = this.py[i] as number;
      this.preZ[i] = this.pz[i] as number;

      let vx = this.vx[i] as number;
      let vy = (this.vy[i] as number) - g * dt;
      let vz = this.vz[i] as number;
      const speed = Math.hypot(vx, vy, vz);
      if (speed > maxSpeed) {
        const k = maxSpeed / speed;
        vx *= k;
        vy *= k;
        vz *= k;
      }
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      this.px[i] = (this.px[i] as number) + vx * dt;
      this.py[i] = (this.py[i] as number) + vy * dt;
      this.pz[i] = (this.pz[i] as number) + vz * dt;
    }
  }

  private cellIndex(x: number, y: number, z: number): number {
    const { min } = this.options.bounds;
    const cx = clampInt(Math.floor((x - min.x) / this.h), 0, this.nx - 1);
    const cy = clampInt(Math.floor((y - min.y) / this.h), 0, this.ny - 1);
    const cz = clampInt(Math.floor((z - min.z) / this.h), 0, this.nz - 1);
    return (cz * this.ny + cy) * this.nx + cx;
  }

  private buildGrid(): void {
    const start = this.cellStart;
    start.fill(0);
    for (let i = 0; i < this.count; i += 1) {
      const cell = this.cellIndex(this.px[i] as number, this.py[i] as number, this.pz[i] as number);
      this.cellOf[i] = cell;
      start[cell + 1] = (start[cell + 1] as number) + 1;
    }
    for (let c = 0; c < this.cellCount; c += 1) {
      start[c + 1] = (start[c + 1] as number) + (start[c] as number);
      this.cellCursor[c] = start[c] as number;
    }
    for (let i = 0; i < this.count; i += 1) {
      const cell = this.cellOf[i] as number;
      const slot = this.cellCursor[cell] as number;
      this.cellEntries[slot] = i;
      this.cellCursor[cell] = slot + 1;
    }
  }

  private buildNeighbors(): void {
    const { min } = this.options.bounds;
    let totalNeighbors = 0;
    let offset = 0;

    for (let i = 0; i < this.count; i += 1) {
      this.neighborStart[i] = offset;
      const x = this.px[i] as number;
      const y = this.py[i] as number;
      const z = this.pz[i] as number;
      const cx = clampInt(Math.floor((x - min.x) / this.h), 0, this.nx - 1);
      const cy = clampInt(Math.floor((y - min.y) / this.h), 0, this.ny - 1);
      const cz = clampInt(Math.floor((z - min.z) / this.h), 0, this.nz - 1);

      let found = 0;
      for (let dz = -1; dz <= 1 && found < MAX_NEIGHBORS; dz += 1) {
        const zz = cz + dz;
        if (zz < 0 || zz >= this.nz) continue;
        for (let dy = -1; dy <= 1 && found < MAX_NEIGHBORS; dy += 1) {
          const yy = cy + dy;
          if (yy < 0 || yy >= this.ny) continue;
          const rowBase = (zz * this.ny + yy) * this.nx;
          for (let dx = -1; dx <= 1 && found < MAX_NEIGHBORS; dx += 1) {
            const xx = cx + dx;
            if (xx < 0 || xx >= this.nx) continue;
            const cell = rowBase + xx;
            const from = this.cellStart[cell] as number;
            const to = this.cellStart[cell + 1] as number;
            for (let k = from; k < to; k += 1) {
              const j = this.cellEntries[k] as number;
              if (j === i) continue;
              const ddx = (this.px[j] as number) - x;
              const ddy = (this.py[j] as number) - y;
              const ddz = (this.pz[j] as number) - z;
              if (ddx * ddx + ddy * ddy + ddz * ddz >= this.h2) continue;
              this.neighborList[offset + found] = j;
              found += 1;
              if (found >= MAX_NEIGHBORS) break;
            }
          }
        }
      }
      totalNeighbors += found;
      offset += found;
    }
    this.neighborStart[this.count] = offset;
    this.avgNeighbors = this.count > 0 ? totalNeighbors / this.count : 0;
  }

  private solveDensity(dt: number): void {
    const rho0 = this.options.restDensity;
    const eps = 1e-3;
    const iterations = Math.max(1, this.options.iterations);
    const tension = this.options.surfaceTension;
    const tensionRef = tension > 0 ? this.poly6 * this.h2 ** 3 : 1;

    for (let iter = 0; iter < iterations; iter += 1) {
      let maxErr = 0;
      // 1) 密度与 lambda
      for (let i = 0; i < this.count; i += 1) {
        const xi = this.px[i] as number;
        const yi = this.py[i] as number;
        const zi = this.pz[i] as number;
        let rho = 0;
        let gradSum = 0;
        const from = this.neighborStart[i] as number;
        const to = this.neighborStart[i + 1] as number;
        for (let k = from; k < to; k += 1) {
          const j = this.neighborList[k] as number;
          const dx = xi - (this.px[j] as number);
          const dy = yi - (this.py[j] as number);
          const dz = zi - (this.pz[j] as number);
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= this.h2) continue;
          const diff = this.h2 - r2;
          rho += this.poly6 * diff * diff * diff;
          const r = Math.sqrt(r2);
          const grad = this.spikyGrad * (this.h - r) * (this.h - r);
          gradSum += grad * grad;
        }
        rho += this.poly6 * this.h2 ** 3; // 自身贡献
        this.density[i] = rho;
        const c = rho / rho0 - 1;
        if (Math.abs(c) > maxErr) maxErr = Math.abs(c);
        this.lambda[i] = -c / (gradSum + eps);
      }
      this.maxDensityError = maxErr;

      // 2) 位置修正
      for (let i = 0; i < this.count; i += 1) {
        const xi = this.px[i] as number;
        const yi = this.py[i] as number;
        const zi = this.pz[i] as number;
        let dpx = 0;
        let dpy = 0;
        let dpz = 0;
        const li = this.lambda[i] as number;
        const from = this.neighborStart[i] as number;
        const to = this.neighborStart[i + 1] as number;
        for (let k = from; k < to; k += 1) {
          const j = this.neighborList[k] as number;
          const dx = xi - (this.px[j] as number);
          const dy = yi - (this.py[j] as number);
          const dz = zi - (this.pz[j] as number);
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= this.h2 || r2 < 1e-12) continue;
          const r = Math.sqrt(r2);
          const coef = this.spikyGrad * (this.h - r) * (this.h - r) / r;
          let scale = li + (this.lambda[j] as number);
          if (tension > 0) {
            const diff = this.h2 - r2;
            const w = this.poly6 * diff * diff * diff;
            const ratio = w / tensionRef;
            scale -= tension * ratio * ratio * ratio * ratio;
          }
          dpx += scale * coef * dx;
          dpy += scale * coef * dy;
          dpz += scale * coef * dz;
        }
        const invRho = 1 / rho0;
        this.px[i] = xi + dpx * invRho;
        this.py[i] = yi + dpy * invRho;
        this.pz[i] = zi + dpz * invRho;
      }
      void dt;
    }
  }

  private applyViscosity(dt: number): void {
    const c = this.options.viscosity;
    if (c <= 0) return;
    const invRho = 1 / this.options.restDensity;
    for (let i = 0; i < this.count; i += 1) {
      const xi = this.px[i] as number;
      const yi = this.py[i] as number;
      const zi = this.pz[i] as number;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      const from = this.neighborStart[i] as number;
      const to = this.neighborStart[i + 1] as number;
      for (let k = from; k < to; k += 1) {
        const j = this.neighborList[k] as number;
        const dx = xi - (this.px[j] as number);
        const dy = yi - (this.py[j] as number);
        const dz = zi - (this.pz[j] as number);
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= this.h2) continue;
        const diff = this.h2 - r2;
        const w = this.poly6 * diff * diff * diff;
        sx += ((this.vx[j] as number) - (this.vx[i] as number)) * w;
        sy += ((this.vy[j] as number) - (this.vy[i] as number)) * w;
        sz += ((this.vz[j] as number) - (this.vz[i] as number)) * w;
      }
      this.vx[i] = (this.vx[i] as number) + c * sx * invRho * dt * 60;
      this.vy[i] = (this.vy[i] as number) + c * sy * invRho * dt * 60;
      this.vz[i] = (this.vz[i] as number) + c * sz * invRho * dt * 60;
    }
  }

  private integrateAndCollide(dt: number, obstacles: readonly Obstacle[]): void {
    const invDt = 1 / dt;
    const { min, max } = this.options.bounds;
    const r = this.options.radius;
    const damp = 0.12;

    for (let i = 0; i < this.count; i += 1) {
      let vx = ((this.px[i] as number) - (this.preX[i] as number)) * invDt;
      let vy = ((this.py[i] as number) - (this.preY[i] as number)) * invDt;
      let vz = ((this.pz[i] as number) - (this.preZ[i] as number)) * invDt;

      let x = this.px[i] as number;
      let y = this.py[i] as number;
      let z = this.pz[i] as number;

      if (x < min.x + r) {
        x = min.x + r;
        vx = Math.abs(vx) * damp;
      } else if (x > max.x - r) {
        x = max.x - r;
        vx = -Math.abs(vx) * damp;
      }
      if (y < min.y + r) {
        y = min.y + r;
        vy = Math.abs(vy) * damp;
        vx *= 0.96;
        vz *= 0.96;
      } else if (y > max.y - r) {
        y = max.y - r;
        vy = -Math.abs(vy) * damp;
      }
      if (z < min.z + r) {
        z = min.z + r;
        vz = Math.abs(vz) * damp;
      } else if (z > max.z - r) {
        z = max.z - r;
        vz = -Math.abs(vz) * damp;
      }

      for (const box of obstacles) {
        const pushed = pushOutBox(x, y, z, r, box);
        x = pushed.x;
        y = pushed.y;
        z = pushed.z;
        if (pushed.hitX !== 0) vx = -vx * damp;
        if (pushed.hitY !== 0) vy = -vy * damp;
        if (pushed.hitZ !== 0) vz = -vz * damp;
      }

      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
    }
  }

  private writeOutput(): void {
    const out = this.positions;
    for (let i = 0; i < this.count; i += 1) {
      const o = i * 3;
      out[o] = this.px[i] as number;
      out[o + 1] = this.py[i] as number;
      out[o + 2] = this.pz[i] as number;
    }
  }
}

interface PushResult {
  x: number;
  y: number;
  z: number;
  hitX: number;
  hitY: number;
  hitZ: number;
}

const noHit: PushResult = { x: 0, y: 0, z: 0, hitX: 0, hitY: 0, hitZ: 0 };

function pushOutBox(x: number, y: number, z: number, r: number, box: Obstacle): PushResult {
  const minX = box.min.x - r;
  const maxX = box.max.x + r;
  const minY = box.min.y - r;
  const maxY = box.max.y + r;
  const minZ = box.min.z - r;
  const maxZ = box.max.z + r;
  if (x <= minX || x >= maxX || y <= minY || y >= maxY || z <= minZ || z >= maxZ) {
    noHit.x = x;
    noHit.y = y;
    noHit.z = z;
    noHit.hitX = 0;
    noHit.hitY = 0;
    noHit.hitZ = 0;
    return noHit;
  }
  // 选穿透最浅的一个面推出，避免粒子卡在盒子里抖动
  const dxMin = x - minX;
  const dxMax = maxX - x;
  const dyMin = y - minY;
  const dyMax = maxY - y;
  const dzMin = z - minZ;
  const dzMax = maxZ - z;
  const m = Math.min(dxMin, dxMax, dyMin, dyMax, dzMin, dzMax);
  noHit.hitX = 0;
  noHit.hitY = 0;
  noHit.hitZ = 0;
  if (m === dxMin) {
    noHit.x = minX;
    noHit.hitX = -1;
  } else if (m === dxMax) {
    noHit.x = maxX;
    noHit.hitX = 1;
  } else {
    noHit.x = x;
  }
  if (m === dyMin) {
    noHit.y = minY;
    noHit.hitY = -1;
  } else if (m === dyMax) {
    noHit.y = maxY;
    noHit.hitY = 1;
  } else {
    noHit.y = y;
  }
  if (m === dzMin) {
    noHit.z = minZ;
    noHit.hitZ = -1;
  } else if (m === dzMax) {
    noHit.z = maxZ;
    noHit.hitZ = 1;
  } else {
    noHit.z = z;
  }
  return noHit;
}

function clampInt(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
