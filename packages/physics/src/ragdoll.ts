import { ObstacleGrid } from './spatial-hash.js';
import type { Obstacle, RagdollOptions } from './types.js';

/** 单次碰撞查询的候选盒上限。一个格子里塞 64 个盒子在游戏场景里不可能出现。 */
const MAX_CANDIDATES = 64;

/**
 * 碰撞皮肤厚度。
 *
 * 点状 Verlet 没有体积，贴着盒面停住会让骨骼线段与盒面共面（z-fighting），
 * 而且躺平时所有点精确落在同一高度，看起来像一张纸。留 0.12 的皮肤，
 * 等价于给每个点一个大约 12 厘米的身体半径。
 */
const SKIN = 0.12;

/**
 * 布娃娃 / 绳索：Verlet 积分 + 距离约束。
 *
 * 为什么不用刚体（四元数 + 关节求解器）：
 * - 网页端布娃娃的用途是「视觉可信」，不是物理正确；
 * - Verlet 无需求逆矩阵，单点每步约 40ns，低端机可跑 2~4 个布娃娃；
 * - 天然支持「拉长 / 断裂」这类游戏性效果（改 restLength 即可）。
 *
 * 代价：无法正确表达自旋惯量，头脚等质量会显得「轻」，用 invMass 权重缓解。
 *
 * 三类优化（都为了「低算力下看起来更好」）：
 * 1. **宽相位**：碰撞查询走 ObstacleGrid，不再逐点遍历全部障碍盒。
 * 2. **休眠**：静止超过 sleepDelay 后整具跳过积分与约束求解，玩家看不见的
 *    布娃娃不该占用 CPU（城市里躺着 50 具尸体是常态）。
 * 3. **渲染插值**：每步开头快照位置，物理 30Hz + 渲染 60Hz 时由渲染层
 *    传入 alpha 做 lerp，消除「果冻感」。
 */
export class Ragdoll {
  readonly id: string;
  readonly pointCount: number;
  readonly boneCount: number;
  /** 当前点位（交错 xyz），渲染层可直接读，无需复制。 */
  readonly positions: Float32Array;
  readonly invMass: Float32Array;

  private readonly prev: Float32Array;
  /** 上一次 step 结束时的位置，供渲染插值。 */
  private readonly renderPrev: Float32Array;
  private readonly bones: Float32Array;
  private readonly pinned: Uint8Array;
  private readonly options: RagdollOptions;

  /** 弯曲限制的三元组（a, b, c）与其最小 |a-c| 距离，预分配。 */
  private readonly bendA: Int32Array;
  private readonly bendC: Int32Array;
  private readonly bendMin: Float32Array;
  private readonly bendCount: number;
  /** 骨骼邻接：点 → 相邻骨骼索引（用于推导弯曲限制）。 */
  private readonly candidateBuf = new Int32Array(MAX_CANDIDATES);

  /** 休眠累计时间（秒）。 */
  private idleTime = 0;
  private asleep = false;
  /** 每点是否与地面/障碍接触，用于「接触开始」事件的边沿检测。 */
  private readonly contactMask: Uint8Array;
  /**
   * 接触开始回调。world 用它把 `collision` 事件转发到事件总线。
   * 只在 0→1 边沿触发，稳态接触不重复发。
   */
  onContact: ((pointIndex: number, obstacleId: string | null, face: number) => void) | null = null;
  /** 睡眠状态翻转回调（入睡/醒来）。 */
  onSleepChange: ((asleep: boolean) => void) | null = null;

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
    this.renderPrev = new Float32Array(positions);
    this.bones = bones;
    this.pinned = new Uint8Array(this.pointCount);
    this.contactMask = new Uint8Array(this.pointCount);

    const bends = buildBendLimits(positions, invMass, bones, options.bendLimit ?? 0.55);
    this.bendA = bends.a;
    this.bendC = bends.c;
    this.bendMin = bends.min;
    this.bendCount = bends.count;
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
      // 斜撑：抑制「面条感」，刚度低不影响手感。
      // 刚度 < 0.8 的骨不参与弯曲限制推导 —— 它们是约束不是骨骼。
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

  /** 是否处于休眠（渲染层可据此跳过更新骨骼矩阵）。 */
  get isAsleep(): boolean {
    return this.asleep;
  }

  /** 唤醒并清零静止计时。任何外力、位移、障碍物变化都应调用。 */
  wake(): void {
    const was = this.asleep;
    this.asleep = false;
    this.idleTime = 0;
    if (was && this.onSleepChange !== null) this.onSleepChange(false);
  }

  /** 给予某点瞬时速度变化（m/s），内部换算成 Verlet 的 prev 偏移。 */
  addImpulse(pointIndex: number, vx: number, vy: number, vz: number): void {
    if (pointIndex < 0 || pointIndex >= this.pointCount) return;
    this.wake();
    const dt = 1 / 60;
    this.prev[pointIndex * 3] = (this.prev[pointIndex * 3] as number) - vx * dt;
    this.prev[pointIndex * 3 + 1] = (this.prev[pointIndex * 3 + 1] as number) - vy * dt;
    this.prev[pointIndex * 3 + 2] = (this.prev[pointIndex * 3 + 2] as number) - vz * dt;
  }

  /**
   * 给所有自由点施加加速度（m/s²），供风力、爆炸、自定义力场使用。
   *
   * 这是 Verlet 的合法施力路径：加速度等价于把 `prev` 反向偏移 a·dt²，
   * 下一步积分时就会体现为速度增量。直接改 `positions` 会破坏
   * 「位置 = 约束求解结果」这个不变量，布娃娃会被拉长或炸开。
   *
   * 对休眠中的布娃娃调用会先唤醒它 —— 引擎无法区分「微风」和「冲击」，
   * 交给调用方决定是否跳过 `isAsleep` 的对象。
   */
  addAcceleration(ax: number, ay: number, az: number, dt: number): void {
    const k = dt * dt;
    const dx = ax * k;
    const dy = ay * k;
    const dz = az * k;
    if (dx === 0 && dy === 0 && dz === 0) return;
    this.wake();
    for (let i = 0; i < this.pointCount; i += 1) {
      if (this.pinned[i] === 1) continue;
      this.prev[i * 3] = (this.prev[i * 3] as number) - dx;
      this.prev[i * 3 + 1] = (this.prev[i * 3 + 1] as number) - dy;
      this.prev[i * 3 + 2] = (this.prev[i * 3 + 2] as number) - dz;
    }
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
      this.addImpulse(
        i,
        (dx / d) * power * falloff,
        (dy / d) * power * falloff + power * 0.4 * falloff,
        (dz / d) * power * falloff,
      );
    }
  }

  pin(pointIndex: number): void {
    if (pointIndex >= 0 && pointIndex < this.pointCount) {
      this.pinned[pointIndex] = 1;
      this.wake();
    }
  }

  unpin(pointIndex: number): void {
    if (pointIndex >= 0 && pointIndex < this.pointCount) {
      this.pinned[pointIndex] = 0;
      this.wake();
    }
  }

  moveTo(x: number, y: number, z: number): void {
    this.wake();
    const ox = x - (this.positions[0] as number);
    const oy = y - (this.positions[1] as number);
    const oz = z - (this.positions[2] as number);
    for (let i = 0; i < this.pointCount; i += 1) {
      this.positions[i * 3] = (this.positions[i * 3] as number) + ox;
      this.positions[i * 3 + 1] = (this.positions[i * 3 + 1] as number) + oy;
      this.positions[i * 3 + 2] = (this.positions[i * 3 + 2] as number) + oz;
      this.prev[i * 3] = (this.prev[i * 3] as number) + ox;
      this.prev[i * 3 + 1] = (this.prev[i * 3 + 1] as number) + oy;
      this.prev[i * 3 + 2] = (this.prev[i * 3 + 2] as number) + oz;
    }
    this.renderPrev.set(this.positions);
  }

  step(dt: number, obstacles: readonly Obstacle[] = [], grid: ObstacleGrid | null = null): void {
    if (this.asleep) return;

    // 插值起点：本步之前的位置。必须在积分前拍快照。
    this.renderPrev.set(this.positions);

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

    this.clampAboveBounds();

    const iterations = Math.max(1, this.options.iterations);
    for (let iter = 0; iter < iterations; iter += 1) {
      this.solveConstraints();
      this.solveBendLimits();
      // 只在首轮上报接触：后续迭代是对同一批穿透的重复修正，
      // 每轮都报会让一个落地瞬间产生 4 倍的事件量
      this.collide(obstacles, grid, iter === 0);
    }

    this.updateSleep(dt);
  }

  /**
   * 上边界整体平移。
   *
   * 逐点钳制 `y = max.y` 看起来无害，实际会把超界的布娃娃**压成一团**：
   * spawn 在 y=20 而边界是 14 时，九个点全被压到 14，形状瞬间丢失。
   * 正确做法是算出最大越界量，整具一起下移，保住相对位置。
   * 下界与水平方向仍逐点钳制 —— 那是「贴墙」，压扁是合理行为。
   */
  private clampAboveBounds(): void {
    const maxY = this.options.bounds.max.y;
    let highest = -Infinity;
    for (let i = 0; i < this.pointCount; i += 1) {
      const y = this.positions[i * 3 + 1] as number;
      if (y > highest) highest = y;
    }
    const over = highest - maxY;
    if (over <= 0) return;
    for (let i = 0; i < this.pointCount; i += 1) {
      this.positions[i * 3 + 1] = (this.positions[i * 3 + 1] as number) - over;
      this.prev[i * 3 + 1] = (this.prev[i * 3 + 1] as number) - over;
    }
  }

  /**
   * 休眠判定。
   *
   * 用「位移 / dt」当速度估计：Verlet 没有显式速度场，而位移就是它的速度。
   * 阈值平方比较避免开方。
   *
   * 只靠时间窗口防误判，不额外判「是否贴地」：
   * 抛到空中的布娃娃在顶点确实有一两帧速度接近 0，但那只持续约 0.03 秒，
   * 远小于 0.5 秒的 sleepDelay，累加不到阈值。反过来，如果按「离地高度」
   * 过滤，站在 3 米高台上的布娃娃就永远不睡 —— 那才是真正的泄漏。
   * 静止就是静止，不管它在哪儿；场景变化时由 `wake()` 负责叫醒。
   */
  private updateSleep(dt: number): void {
    const delay = this.options.sleepDelay ?? 0.5;
    if (delay <= 0) return;

    const threshold = this.options.sleepThreshold ?? 0.08;
    const t2 = threshold * threshold;
    let maxSpeedSq = 0;
    let moving = 0;
    for (let i = 0; i < this.pointCount; i += 1) {
      if (this.pinned[i] === 1) continue;
      moving += 1;
      // 用 renderPrev（本步开始时的快照）而不是 prev：
      // prev 会被碰撞推出改写，包含「穿透修正」这部分非运动位移，
      // 拿它当速度会让静止的布娃娃算出 0.1m/s 以上的假速度，永远睡不着。
      const dx = (this.positions[i * 3] as number) - (this.renderPrev[i * 3] as number);
      const dy = (this.positions[i * 3 + 1] as number) - (this.renderPrev[i * 3 + 1] as number);
      const dz = (this.positions[i * 3 + 2] as number) - (this.renderPrev[i * 3 + 2] as number);
      const s2 = (dx * dx + dy * dy + dz * dz) / (dt * dt);
      if (s2 > maxSpeedSq) maxSpeedSq = s2;
    }

    // 全部点都被 pin 住时不存在「自由运动」，不该计入休眠统计
    if (moving === 0) return;

    if (maxSpeedSq < t2) {
      this.idleTime += dt;
      if (this.idleTime >= delay) {
        this.asleep = true;
        if (this.onSleepChange !== null) this.onSleepChange(true);
        // 睡眠时把 prev 对齐 positions，避免唤醒瞬间的虚假速度把布娃娃弹飞
        this.prev.set(this.positions);
        this.renderPrev.set(this.positions);
      }
    } else {
      this.idleTime = 0;
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

  /**
   * 带渲染插值的线段输出。
   *
   * `alpha` 是物理步之间的插值系数：物理 30Hz、渲染 60Hz 时，
   * 渲染第 N 帧传 0、第 N+1 帧传 0.5、第 N+2 帧传 0（新的一步）。
   * 不插值时低帧率物理会看到阶梯式跳动，也就是「果冻感」的来源之一。
   */
  writeInterpolatedSegments(out: Float32Array, alpha: number): void {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    for (let b = 0; b < this.boneCount; b += 1) {
      const i = this.bones[b * 4] as number;
      const j = this.bones[b * 4 + 1] as number;
      const o = b * 6;
      out[o] = lerp(this.renderPrev[i * 3] as number, this.positions[i * 3] as number, a);
      out[o + 1] = lerp(this.renderPrev[i * 3 + 1] as number, this.positions[i * 3 + 1] as number, a);
      out[o + 2] = lerp(this.renderPrev[i * 3 + 2] as number, this.positions[i * 3 + 2] as number, a);
      out[o + 3] = lerp(this.renderPrev[j * 3] as number, this.positions[j * 3] as number, a);
      out[o + 4] = lerp(this.renderPrev[j * 3 + 1] as number, this.positions[j * 3 + 1] as number, a);
      out[o + 5] = lerp(this.renderPrev[j * 3 + 2] as number, this.positions[j * 3 + 2] as number, a);
    }
  }

  /**
   * 插值后的点坐标（交错 xyz），供渲染层画关节点。
   *
   * 骨骼线段与关节点必须用同一个 alpha，否则画面上线和点会错开半帧，
   * 布娃娃快速翻滚时看起来像「点追着线跑」。
   */
  writePointPositions(out: Float32Array, alpha: number): void {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    for (let i = 0; i < this.pointCount; i += 1) {
      out[i * 3] = lerp(this.renderPrev[i * 3] as number, this.positions[i * 3] as number, a);
      out[i * 3 + 1] = lerp(this.renderPrev[i * 3 + 1] as number, this.positions[i * 3 + 1] as number, a);
      out[i * 3 + 2] = lerp(this.renderPrev[i * 3 + 2] as number, this.positions[i * 3 + 2] as number, a);
    }
  }

  /**
   * 绳索类（链式）的 Catmull-Rom 平滑点列，输出 `pointCount × subdivisions + 1` 个点。
   *
   * 直接连线段在段数少时能看到折角，尤其绳子甩起来的时候。
   * Catmull-Rom 只读 4 个控制点、无需求解，成本是每点 3 次多项式，
   * 比「加密 Verlet 段数」便宜得多（后者会让约束求解量平方增长）。
   *
   * 返回写入的点数；`out` 不够长时返回 0（调用方负责分配）。
   */
  writeSmoothPolyline(out: Float32Array, subdivisions = 4): number {
    if (this.pointCount < 2) return 0;
    const sub = Math.max(1, Math.floor(subdivisions));
    const needed = (this.pointCount - 1) * sub + 1;
    if (out.length < needed * 3) return 0;

    const p = this.positions;
    let w = 0;
    for (let i = 0; i < this.pointCount - 1; i += 1) {
      const i0 = i > 0 ? i - 1 : i;
      const i1 = i;
      const i2 = i + 1;
      const i3 = i + 2 < this.pointCount ? i + 2 : i + 1;
      const x0 = p[i0 * 3] as number;
      const y0 = p[i0 * 3 + 1] as number;
      const z0 = p[i0 * 3 + 2] as number;
      const x1 = p[i1 * 3] as number;
      const y1 = p[i1 * 3 + 1] as number;
      const z1 = p[i1 * 3 + 2] as number;
      const x2 = p[i2 * 3] as number;
      const y2 = p[i2 * 3 + 1] as number;
      const z2 = p[i2 * 3 + 2] as number;
      const x3 = p[i3 * 3] as number;
      const y3 = p[i3 * 3 + 1] as number;
      const z3 = p[i3 * 3 + 2] as number;
      for (let s = 0; s < sub; s += 1) {
        const t = s / sub;
        out[w] = catmull(x0, x1, x2, x3, t);
        out[w + 1] = catmull(y0, y1, y2, y3, t);
        out[w + 2] = catmull(z0, z1, z2, z3, t);
        w += 3;
      }
    }
    const last = (this.pointCount - 1) * 3;
    out[w] = p[last] as number;
    out[w + 1] = p[last + 1] as number;
    out[w + 2] = p[last + 2] as number;
    return needed;
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

  /**
   * 关节弯曲软限制。
   *
   * Verlet 只有距离约束，肘和膝盖能往反方向折 —— 布娃娃落地时会摆出
   * 「手腕贴小臂」这种人体做不到的姿势，一眼假。
   *
   * 做法：对链上相邻的两根骨 (a-b, b-c)，限制 |a-c| 不小于 bendLimit × 骨长和。
   * 这是一个单边距离约束，成本与普通骨骼相同，不会引入角度计算。
   * 用软限制（不完全推到边界）而不是硬约束，保留一点「橡皮感」更自然。
   */
  private solveBendLimits(): void {
    for (let k = 0; k < this.bendCount; k += 1) {
      const a = this.bendA[k] as number;
      const c = this.bendC[k] as number;
      const wa = this.invMass[a] as number;
      const wc = this.invMass[c] as number;
      const wSum = wa + wc;
      if (wSum <= 0) continue;

      const dx = (this.positions[c * 3] as number) - (this.positions[a * 3] as number);
      const dy = (this.positions[c * 3 + 1] as number) - (this.positions[a * 3 + 1] as number);
      const dz = (this.positions[c * 3 + 2] as number) - (this.positions[a * 3 + 2] as number);
      const dist = Math.hypot(dx, dy, dz);
      const min = this.bendMin[k] as number;
      if (dist >= min || dist < 1e-6) continue;

      // 0.5 的软度：一次迭代只修正一半，多迭代逼近边界，避免抖动
      const push = ((min - dist) / dist) * 0.5;
      const px = dx * push;
      const py = dy * push;
      const pz = dz * push;
      this.positions[a * 3] = (this.positions[a * 3] as number) - (px * wa) / wSum;
      this.positions[a * 3 + 1] = (this.positions[a * 3 + 1] as number) - (py * wa) / wSum;
      this.positions[a * 3 + 2] = (this.positions[a * 3 + 2] as number) - (pz * wa) / wSum;
      this.positions[c * 3] = (this.positions[c * 3] as number) + (px * wc) / wSum;
      this.positions[c * 3 + 1] = (this.positions[c * 3 + 1] as number) + (py * wc) / wSum;
      this.positions[c * 3 + 2] = (this.positions[c * 3 + 2] as number) + (pz * wc) / wSum;
    }
  }

  private collide(obstacles: readonly Obstacle[], grid: ObstacleGrid | null, reportContact = false): void {
    // 点状 Verlet 没有体积，直接贴地会塌成一张纸；给 0.12 的「身体厚度」当近似半径，
    // 顺带避免线段与地面网格在 y=0 处 z-fighting。
    const ground = this.options.groundY + SKIN;
    const { min, max } = this.options.bounds;
    const friction = 1 - this.options.friction;
    const buf = this.candidateBuf;

    for (let i = 0; i < this.pointCount; i += 1) {
      let x = this.positions[i * 3] as number;
      let y = this.positions[i * 3 + 1] as number;
      let z = this.positions[i * 3 + 2] as number;
      const beforeX = x;
      const beforeY = y;
      const beforeZ = z;
      let hitFace = -1;

      let hitObstacleId: string | null = null;
      if (y < ground) {
        y = ground;
        hitObstacleId = null;
        const px = this.prev[i * 3] as number;
        const pz = this.prev[i * 3 + 2] as number;
        this.prev[i * 3] = x + (px - x) * friction;
        this.prev[i * 3 + 2] = z + (pz - z) * friction;
        // 法向速度归零：不归零的话「穿透深度」会在下一帧变成向上的速度，
        // 于是布娃娃在地面和盒顶之间永久抖动，永远到不了休眠阈值
        this.prev[i * 3 + 1] = y;
      }
      if (x < min.x) x = min.x;
      else if (x > max.x) x = max.x;
      if (y > max.y) y = max.y;
      if (z < min.z) z = min.z;
      else if (z > max.z) z = max.z;

      if (grid !== null) {
        const n = grid.queryPoint(x, y, z, buf);
        for (let c = 0; c < n; c += 1) {
          const box = obstacles[buf[c] as number];
          if (box === undefined || box.kind !== 'solid') continue;
          // 检测面必须与推出面重合（都外扩 SKIN），否则点会落在
          // 「盒面 ~ 盒面+SKIN」这条缝里无限自由落体：每 5 帧掉 0.12 米再被弹回，
          // 实测速度恒定在 0.8m/s，布娃娃永远达不到休眠阈值。
          const minX = box.min.x - SKIN;
          const minY = box.min.y - SKIN;
          const minZ = box.min.z - SKIN;
          const maxX = box.max.x + SKIN;
          const maxY = box.max.y + SKIN;
          const maxZ = box.max.z + SKIN;
          if (x <= minX || x >= maxX) continue;
          if (y <= minY || y >= maxY) continue;
          if (z <= minZ || z >= maxZ) continue;
          const face = exitFace(
            this.prev[i * 3] as number,
            this.prev[i * 3 + 1] as number,
            this.prev[i * 3 + 2] as number,
            minX,
            minY,
            minZ,
            maxX,
            maxY,
            maxZ,
            x,
            y,
            z,
          );
          hitFace = face;
          hitObstacleId = box.id;
          if (face === 0) x = maxX;
          else if (face === 1) x = minX;
          else if (face === 2) y = maxY;
          else if (face === 3) y = minY;
          else if (face === 4) z = maxZ;
          else z = minZ;
        }
      } else {
        // 没有网格时的退化路径：保持旧行为，便于单测与调试
        for (let b = 0; b < obstacles.length; b += 1) {
          const box = obstacles[b] as Obstacle;
          if (box.kind !== 'solid') continue;
          const minX = box.min.x - SKIN;
          const minY = box.min.y - SKIN;
          const minZ = box.min.z - SKIN;
          const maxX = box.max.x + SKIN;
          const maxY = box.max.y + SKIN;
          const maxZ = box.max.z + SKIN;
          if (x <= minX || x >= maxX) continue;
          if (y <= minY || y >= maxY) continue;
          if (z <= minZ || z >= maxZ) continue;
          const face = exitFace(
            this.prev[i * 3] as number,
            this.prev[i * 3 + 1] as number,
            this.prev[i * 3 + 2] as number,
            minX,
            minY,
            minZ,
            maxX,
            maxY,
            maxZ,
            x,
            y,
            z,
          );
          hitFace = face;
          hitObstacleId = box.id;
          if (face === 0) x = maxX;
          else if (face === 1) x = minX;
          else if (face === 2) y = maxY;
          else if (face === 3) y = minY;
          else if (face === 4) z = maxZ;
          else z = minZ;
        }
      }

      if (reportContact) {
        const touching = hitFace >= 0 || (y <= ground && beforeY < ground);
        if (touching && this.contactMask[i] === 0 && this.onContact !== null) {
          this.onContact(i, hitObstacleId, hitFace);
        }
        this.contactMask[i] = touching ? 1 : 0;
      }

      // 盒子修正是「穿透深度」，不是运动。直接留在 prev 里会让下一帧
      // 把这部分位移当成速度，表面上看是布娃娃在盒顶不停弹跳（实测 20 秒不停）。
      // 先把 prev 跟着平移保住真实速度，再按法向归零 + 切向摩擦处理。
      if (hitFace >= 0) {
        const sx = x - beforeX;
        const sy = y - beforeY;
        const sz = z - beforeZ;
        let pvx = (this.prev[i * 3] as number) + sx;
        let pvy = (this.prev[i * 3 + 1] as number) + sy;
        let pvz = (this.prev[i * 3 + 2] as number) + sz;
        if (hitFace === 2 || hitFace === 3) {
          pvy = y;
          pvx = x + (pvx - x) * friction;
          pvz = z + (pvz - z) * friction;
        } else if (hitFace === 0 || hitFace === 1) {
          pvx = x;
          pvy = y + (pvy - y) * friction;
          pvz = z + (pvz - z) * friction;
        } else {
          pvz = z;
          pvx = x + (pvx - x) * friction;
          pvy = y + (pvy - y) * friction;
        }
        this.prev[i * 3] = pvx;
        this.prev[i * 3 + 1] = pvy;
        this.prev[i * 3 + 2] = pvz;
      }

      this.positions[i * 3] = x;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = z;
    }
  }
}

/**
 * 从骨骼表推导弯曲限制三元组。
 *
 * 只对「链式」关系生效：点 b 同时是骨 (a,b) 与 (b,c) 的端点，且两根骨的
 * 刚度都 ≥ 0.8（排除 humanoid 里的斜撑）。一具人形布娃娃推导出 6 组，
 * 绳索推导出 n-2 组。
 */
function buildBendLimits(
  points: Float32Array,
  invMass: Float32Array,
  bones: Float32Array,
  bendLimit: number,
): { a: Int32Array; c: Int32Array; min: Float32Array; count: number } {
  const boneCount = bones.length / 4;
  const pointCount = invMass.length;
  const limit = Math.max(0.05, Math.min(0.95, bendLimit));

  // 每个点关联的「硬」骨索引（度数通常 ≤ 4，用定长 4 够）
  const deg = new Uint8Array(pointCount);
  const slots = new Int32Array(pointCount * 4).fill(-1);

  for (let b = 0; b < boneCount; b += 1) {
    if ((bones[b * 4 + 3] as number) < 0.8) continue;
    const i = bones[b * 4] as number;
    const j = bones[b * 4 + 1] as number;
    if (i < pointCount && (deg[i] as number) < 4) {
      slots[i * 4 + (deg[i] as number)] = b;
      deg[i] = (deg[i] as number) + 1;
    }
    if (j < pointCount && (deg[j] as number) < 4) {
      slots[j * 4 + (deg[j] as number)] = b;
      deg[j] = (deg[j] as number) + 1;
    }
  }

  const pairsA = new Int32Array(boneCount);
  const pairsC = new Int32Array(boneCount);
  const pairsMin = new Float32Array(boneCount);
  let count = 0;

  for (let p = 0; p < pointCount; p += 1) {
    const d = deg[p] as number;
    for (let x = 0; x < d; x += 1) {
      const b1 = slots[p * 4 + x] as number;
      if (b1 < 0) continue;
      for (let y = x + 1; y < d; y += 1) {
        const b2 = slots[p * 4 + y] as number;
        if (b2 < 0 || b1 === b2) continue;
        const a1 = bones[b1 * 4] as number;
        const c1 = bones[b1 * 4 + 1] as number;
        const a2 = bones[b2 * 4] as number;
        const c2 = bones[b2 * 4 + 1] as number;
        const a = a1 === p ? c1 : a1;
        const c = a2 === p ? c2 : a2;
        if (a === c) continue;
        const len1 = bones[b1 * 4 + 2] as number;
        const len2 = bones[b2 * 4 + 2] as number;
        pairsA[count] = a;
        pairsC[count] = c;
        // 完全伸直时 |a-c| = len1 + len2；限制到这个值的 limit 倍 ≈ 关节最小夹角
        pairsMin[count] = (len1 + len2) * limit;
        count += 1;
      }
    }
  }

  // 距离已在构造时由 layout 决定，points 参数只用于将来可能的自适应（保留签名）
  void points;

  return {
    a: pairsA.subarray(0, count).slice(),
    c: pairsC.subarray(0, count).slice(),
    min: pairsMin.subarray(0, count).slice(),
    count,
  };
}

/**
 * 判断从盒子的哪一面推出。返回 0:+x 1:-x 2:+y 3:-y 4:+z 5:-z。
 *
 * 关键是**用上一帧位置判断入口面**，而不是无脑选最近面。
 *
 * 布娃娃从高处落下时一帧能位移 0.3 米，很容易直接穿进楼板内部。
 * 此时「最近面」经常是侧面甚至底面 —— 结果是一具布娃娃被从楼底顶出来，
 * 或者几个点分别被推到不同面，整具拉成一张纸。
 * 用 prev 判断：如果上一帧还在盒子上方（prevY >= max.y），那就是从上面进来的，
 * 必须顶回上面。这同时也是 CCD 的廉价替代（只对静态盒有效）。
 *
 * prev 也在盒内（生成时就在墙里）时才退回最近面 —— 这种情况下
 * 入口信息本来就不存在，怎么推都可能不对，取最近面是伤害最小的选择。
 */
function exitFace(
  prevX: number,
  prevY: number,
  prevZ: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  x: number,
  y: number,
  z: number,
): number {
  if (prevY >= maxY) return 2;
  if (prevY <= minY) return 3;
  if (prevX >= maxX) return 0;
  if (prevX <= minX) return 1;
  if (prevZ >= maxZ) return 4;
  if (prevZ <= minZ) return 5;

  const dxMin = x - minX;
  const dxMax = maxX - x;
  const dyMin = y - minY;
  const dyMax = maxY - y;
  const dzMin = z - minZ;
  const dzMax = maxZ - z;
  const m = Math.min(dxMin, dxMax, dyMin, dyMax, dzMin, dzMax);
  if (m === dyMax) return 2;
  if (m === dyMin) return 3;
  if (m === dxMin) return 1;
  if (m === dxMax) return 0;
  if (m === dzMin) return 5;
  return 4;
}

function distance(points: Float32Array, a: number, b: number): number {
  const dx = (points[a * 3] as number) - (points[b * 3] as number);
  const dy = (points[a * 3 + 1] as number) - (points[b * 3 + 1] as number);
  const dz = (points[a * 3 + 2] as number) - (points[b * 3 + 2] as number);
  return Math.hypot(dx, dy, dz);
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
