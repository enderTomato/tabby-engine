import type { Obstacle, RagdollOptions } from './types.js';

/**
 * 布娃娃 / 绳索：Verlet 积分 + 距离约束。
 *
 * 为什么不用刚体（四元数 + 关节求解器）：
 * - 网页端布娃娃的用途是「视觉可信」，不是物理正确；
 * - Verlet 无需求逆矩阵，单点每步约 40ns，低端机可跑 2~4 个布娃娃；
 * - 天然支持「拉长 / 断裂」这类游戏性效果（改 restLength 即可）。
 *
 * 代价：无法正确表达自旋惯量，头脚等质量会显得「轻」，用 invMass 权重缓解。
 */
export class Ragdoll {
  readonly id: string;
  readonly pointCount: number;
  readonly boneCount: number;
  /** 当前点位（交错 xyz），渲染层可直接读，无需复制。 */
  readonly positions: Float32Array;
  readonly invMass: Float32Array;

  private readonly prev: Float32Array;
  private readonly bones: Float32Array;
  private readonly pinned: Uint8Array;
  private readonly options: RagdollOptions;

  constructor(
    id: string,
    options: RagdollOptions,
    positions: Float32Array,
    invMass: Float32Array,
    bones: Float32Array,
  ) {
    this.id = id;
    this.options = options;
    this.positions = positions;
    this.invMass = invMass;
    this.pointCount = invMass.length;
    this.boneCount = bones.length / 4;
    this.prev = new Float32Array(positions);
    this.bones = bones;
    this.pinned = new Uint8Array(this.pointCount);
  }

  /** 人形布娃娃：9 点 10 骨，够用且成本低。 */
  static humanoid(
    id: string,
    x: number,
    y: number,
    z: number,
    scale: number,
    options: RagdollOptions,
  ): Ragdoll {
    const layout: readonly (readonly [number, number, number, number])[] = [
      [0, 1.5, 0, 1.2],
      [0, 0.9, 0, 1],
      [0, 0.4, 0, 1],
      [-0.45, 0.85, 0, 1.4],
      [0.45, 0.85, 0, 1.4],
      [-0.18, -0.1, 0, 1.1],
      [0.18, -0.1, 0, 1.1],
      [-0.2, -0.7, 0, 1.6],
      [0.2, -0.7, 0, 1.6],
    ];
    const points = new Float32Array(layout.length * 3);
    const invMass = new Float32Array(layout.length);
    layout.forEach((p, i) => {
      points[i * 3] = x + p[0] * scale;
      points[i * 3 + 1] = y + p[1] * scale;
      points[i * 3 + 2] = z + p[2] * scale;
      invMass[i] = p[3];
    });

    const links: readonly (readonly [number, number, number])[] = [
      [0, 1, 1],
      [1, 2, 1],
      [1, 3, 1],
      [1, 4, 1],
      [2, 5, 1],
      [2, 6, 1],
      [5, 7, 1],
      [6, 8, 1],
      // 斜撑：抑制「面条感」，刚度低不影响手感
      [0, 2, 0.25],
      [3, 4, 0.08],
    ];
    const bones = new Float32Array(links.length * 4);
    links.forEach((link, i) => {
      const a = link[0];
      const b = link[1];
      bones[i * 4] = a;
      bones[i * 4 + 1] = b;
      bones[i * 4 + 2] = distance(points, a, b);
      bones[i * 4 + 3] = link[2];
    });

    return new Ragdoll(id, options, points, invMass, bones);
  }

  /** 绳索 / 藤蔓：首点固定，其余自由摆动。 */
  static rope(
    id: string,
    x: number,
    y: number,
    z: number,
    segments: number,
    segmentLength: number,
    options: RagdollOptions,
  ): Ragdoll {
    const n = Math.max(2, Math.floor(segments));
    const points = new Float32Array(n * 3);
    const invMass = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      points[i * 3] = x;
      points[i * 3 + 1] = y - i * segmentLength;
      points[i * 3 + 2] = z;
      invMass[i] = i === 0 ? 0 : 1;
    }
    const bones = new Float32Array((n - 1) * 4);
    for (let i = 0; i < n - 1; i += 1) {
      bones[i * 4] = i;
      bones[i * 4 + 1] = i + 1;
      bones[i * 4 + 2] = segmentLength;
      bones[i * 4 + 3] = 1;
    }
    return new Ragdoll(id, options, points, invMass, bones);
  }

  /** 给予某点瞬时速度变化（m/s），内部换算成 Verlet 的 prev 偏移。 */
  addImpulse(pointIndex: number, vx: number, vy: number, vz: number): void {
    if (pointIndex < 0 || pointIndex >= this.pointCount) return;
    const dt = 1 / 60;
    this.prev[pointIndex * 3] = (this.prev[pointIndex * 3] as number) - vx * dt;
    this.prev[pointIndex * 3 + 1] = (this.prev[pointIndex * 3 + 1] as number) - vy * dt;
    this.prev[pointIndex * 3 + 2] = (this.prev[pointIndex * 3 + 2] as number) - vz * dt;
  }

  /** 整具布娃娃受击（按点索引循环衰减）。 */
  addRadialImpulse(cx: number, cy: number, cz: number, radius: number, power: number): void {
    const r2 = radius * radius;
    for (let i = 0; i < this.pointCount; i += 1) {
      const dx = (this.positions[i * 3] as number) - cx;
      const dy = (this.positions[i * 3 + 1] as number) - cy;
      const dz = (this.positions[i * 3 + 2] as number) - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) || 1;
      const falloff = 1 - d / radius;
      this.addImpulse(i, (dx / d) * power * falloff, (dy / d) * power * falloff + power * 0.4 * falloff, (dz / d) * power * falloff);
    }
  }

  pin(pointIndex: number): void {
    if (pointIndex >= 0 && pointIndex < this.pointCount) this.pinned[pointIndex] = 1;
  }

  unpin(pointIndex: number): void {
    if (pointIndex >= 0 && pointIndex < this.pointCount) this.pinned[pointIndex] = 0;
  }

  moveTo(x: number, y: number, z: number): void {
    const ox = x - (this.positions[0] as number);
    const oy = y - (this.positions[0] as number);
    const oz = z - (this.positions[2] as number);
    for (let i = 0; i < this.pointCount; i += 1) {
      this.positions[i * 3] = (this.positions[i * 3] as number) + ox;
      this.positions[i * 3 + 1] = (this.positions[i * 3 + 1] as number) + oy;
      this.positions[i * 3 + 2] = (this.positions[i * 3 + 2] as number) + oz;
      this.prev[i * 3] = (this.prev[i * 3] as number) + ox;
      this.prev[i * 3 + 1] = (this.prev[i * 3 + 1] as number) + oy;
      this.prev[i * 3 + 2] = (this.prev[i * 3 + 2] as number) + oz;
    }
  }

  step(dt: number, obstacles: readonly Obstacle[] = []): void {
    const damping = this.options.damping;
    const g = this.options.gravity;
    const gdt2 = g * dt * dt;

    for (let i = 0; i < this.pointCount; i += 1) {
      if (this.pinned[i] === 1) {
        this.prev[i * 3] = this.positions[i * 3] as number;
        this.prev[i * 3 + 1] = this.positions[i * 3 + 1] as number;
        this.prev[i * 3 + 2] = this.positions[i * 3 + 2] as number;
        continue;
      }
      const x = this.positions[i * 3] as number;
      const y = this.positions[i * 3 + 1] as number;
      const z = this.positions[i * 3 + 2] as number;
      const vx = (x - (this.prev[i * 3] as number)) * damping;
      const vy = (y - (this.prev[i * 3 + 1] as number)) * damping;
      const vz = (z - (this.prev[i * 3 + 2] as number)) * damping;
      this.prev[i * 3] = x;
      this.prev[i * 3 + 1] = y;
      this.prev[i * 3 + 2] = z;
      this.positions[i * 3] = x + vx;
      this.positions[i * 3 + 1] = y + vy - gdt2;
      this.positions[i * 3 + 2] = z + vz;
    }

    const iterations = Math.max(1, this.options.iterations);
    for (let iter = 0; iter < iterations; iter += 1) {
      this.solveConstraints();
      this.collide(obstacles);
    }
  }

  /** 供渲染层读取骨骼线段（交错 x1,y1,z1,x2,y2,z2...）。 */
  writeSegments(out: Float32Array): void {
    for (let b = 0; b < this.boneCount; b += 1) {
      const i = this.bones[b * 4] as number;
      const j = this.bones[b * 4 + 1] as number;
      out[b * 6] = this.positions[i * 3] as number;
      out[b * 6 + 1] = this.positions[i * 3 + 1] as number;
      out[b * 6 + 2] = this.positions[i * 3 + 2] as number;
      out[b * 6 + 3] = this.positions[j * 3] as number;
      out[b * 6 + 4] = this.positions[j * 3 + 1] as number;
      out[b * 6 + 5] = this.positions[j * 3 + 2] as number;
    }
  }

  private solveConstraints(): void {
    for (let b = 0; b < this.boneCount; b += 1) {
      const i = this.bones[b * 4] as number;
      const j = this.bones[b * 4 + 1] as number;
      const rest = this.bones[b * 4 + 2] as number;
      const stiffness = this.bones[b * 4 + 3] as number;
      const wi = this.invMass[i] as number;
      const wj = this.invMass[j] as number;
      const wSum = wi + wj;
      if (wSum <= 0) continue;

      const dx = (this.positions[j * 3] as number) - (this.positions[i * 3] as number);
      const dy = (this.positions[j * 3 + 1] as number) - (this.positions[i * 3 + 1] as number);
      const dz = (this.positions[j * 3 + 2] as number) - (this.positions[i * 3 + 2] as number);
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 1e-6) continue;

      const diff = ((dist - rest) / dist) * stiffness;
      const kx = dx * diff;
      const ky = dy * diff;
      const kz = dz * diff;

      this.positions[i * 3] = (this.positions[i * 3] as number) + (kx * wi) / wSum;
      this.positions[i * 3 + 1] = (this.positions[i * 3 + 1] as number) + (ky * wi) / wSum;
      this.positions[i * 3 + 2] = (this.positions[i * 3 + 2] as number) + (kz * wi) / wSum;
      this.positions[j * 3] = (this.positions[j * 3] as number) - (kx * wj) / wSum;
      this.positions[j * 3 + 1] = (this.positions[j * 3 + 1] as number) - (ky * wj) / wSum;
      this.positions[j * 3 + 2] = (this.positions[j * 3 + 2] as number) - (kz * wj) / wSum;
    }
  }

  private collide(obstacles: readonly Obstacle[]): void {
    // 点状 Verlet 没有体积，直接贴地会塌成一张纸；给 0.12 的"身体厚度"当近似半径，
    // 顺带避免线段与地面网格在 y=0 处 z-fighting。
    const ground = this.options.groundY + 0.12;
    const { min, max } = this.options.bounds;
    const friction = 1 - this.options.friction;
    for (let i = 0; i < this.pointCount; i += 1) {
      let x = this.positions[i * 3] as number;
      let y = this.positions[i * 3 + 1] as number;
      let z = this.positions[i * 3 + 2] as number;

      if (y < ground) {
        y = ground;
        const px = this.prev[i * 3] as number;
        const pz = this.prev[i * 3 + 2] as number;
        this.prev[i * 3] = x + (px - x) * friction;
        this.prev[i * 3 + 2] = z + (pz - z) * friction;
      }
      if (x < min.x) x = min.x;
      else if (x > max.x) x = max.x;
      if (y > max.y) y = max.y;
      if (z < min.z) z = min.z;
      else if (z > max.z) z = max.z;

      for (const box of obstacles) {
        if (box.kind !== 'solid') continue;
        if (x > box.min.x && x < box.max.x && y > box.min.y && y < box.max.y && z > box.min.z && z < box.max.z) {
          const dxMin = x - box.min.x;
          const dxMax = box.max.x - x;
          const dyMax = box.max.y - y;
          const dzMin = z - box.min.z;
          const dzMax = box.max.z - z;
          const m = Math.min(dxMin, dxMax, dyMax, dzMin, dzMax);
          if (m === dyMax) y = box.max.y;
          else if (m === dxMin) x = box.min.x;
          else if (m === dxMax) x = box.max.x;
          else if (m === dzMin) z = box.min.z;
          else z = box.max.z;
        }
      }

      this.positions[i * 3] = x;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = z;
    }
  }
}

function distance(points: Float32Array, a: number, b: number): number {
  const dx = (points[a * 3] as number) - (points[b * 3] as number);
  const dy = (points[a * 3 + 1] as number) - (points[b * 3 + 1] as number);
  const dz = (points[a * 3 + 2] as number) - (points[b * 3 + 2] as number);
  return Math.hypot(dx, dy, dz);
}
