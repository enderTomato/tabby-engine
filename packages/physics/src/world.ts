import { FluidSolver } from './fluid.js';
import { Pendulum, type PendulumConfig } from './pendulum.js';
import { Ragdoll } from './ragdoll.js';
import { SmokeSystem } from './smoke.js';
import type {
  FluidOptions,
  Obstacle,
  PhysicsBounds,
  PhysicsStats,
  RagdollOptions,
  SmokeOptions,
} from './types.js';

export interface PhysicsWorldOptions {
  /** 重力标量（m/s²），沿 -Y。 */
  readonly gravity?: number;
  readonly fixedDt?: number;
  readonly bounds?: PhysicsBounds;
  readonly fluid?: Partial<FluidOptions> | null;
  readonly smoke?: Partial<SmokeOptions> | null;
  readonly ragdoll?: Partial<RagdollOptions>;
  readonly seed?: number;
}

export const DEFAULT_BOUNDS: PhysicsBounds = {
  min: { x: -12, y: 0, z: -12 },
  max: { x: 12, y: 14, z: 12 },
};

/**
 * 物理世界：唯一允许被「渲染层」引用的物理入口。
 *
 * 边界约定（半开源 API 的硬约束）：
 * - 本包不 import three / pixi，也不认识 Canvas；
 * - 渲染层只能通过 `fluid.positions` / `smoke.renderData` / `ragdoll.positions`
 *   这些 TypedArray 读状态，不得反向写入；
 * - 所有几何量用「世界单位 + 右手系 + Y 向上」，渲染适配层负责坐标系转换。
 */
export class PhysicsWorld {
  readonly gravity: number;
  readonly fixedDt: number;
  readonly bounds: PhysicsBounds;
  /** 为 null 表示流体由外部（Worker）驱动，本世界只跑布娃娃/摆/烟雾。 */
  readonly fluid: FluidSolver | null;
  readonly smoke: SmokeSystem;
  readonly obstacles: Obstacle[] = [];

  private readonly ragdolls = new Map<string, Ragdoll>();
  private readonly pendulums = new Map<string, Pendulum>();
  /**
   * 步进顺序用显式数组，不遍历 Map。
   * JS 的 Map 虽然是插入序，但「依赖容器序」本身是确定性红线（P04 §7 / P18 §6）：
   * 一旦有人为了释放内存先删再插，顺序就变了，存档回放会跨设备对不上。
   * 数组顺序由本类显式维护，增删都可审计。
   */
  private readonly ragdollOrder: Ragdoll[] = [];
  private readonly pendulumOrder: Pendulum[] = [];
  private readonly ragdollOptions: RagdollOptions;
  private lastStepMs = 0;
  private simulationTime = 0;

  constructor(options: PhysicsWorldOptions = {}) {
    this.gravity = options.gravity ?? 9.8;
    this.fixedDt = options.fixedDt ?? 1 / 60;
    this.bounds = options.bounds ?? DEFAULT_BOUNDS;

    const fluidOptions: FluidOptions = {
      capacity: 1500,
      smoothingRadius: 1,
      restDensity: 6,
      iterations: 2,
      viscosity: 0.08,
      gravity: this.gravity,
      bounds: this.bounds,
      radius: 0.22,
      maxSpeed: 22,
      surfaceTension: 0.0006,
      ...options.fluid,
    };
    this.fluid = options.fluid === null ? null : new FluidSolver(fluidOptions, options.seed ?? 1);

    const smokeOptions: SmokeOptions = {
      capacity: 300,
      gravity: this.gravity,
      buoyancy: 11,
      drag: 0.8,
      life: 3.2,
      startSize: 0.35,
      endSize: 1.6,
      bounds: this.bounds,
      ...options.smoke,
    };
    this.smoke = new SmokeSystem(smokeOptions, (options.seed ?? 1) + 3);

    this.ragdollOptions = {
      gravity: this.gravity * 0.9,
      damping: 0.995,
      iterations: 4,
      groundY: this.bounds.min.y,
      friction: 0.35,
      bounds: this.bounds,
      ...options.ragdoll,
    };
  }

  addObstacle(obstacle: Obstacle): void {
    const index = this.obstacles.findIndex((o) => o.id === obstacle.id);
    if (index >= 0) this.obstacles[index] = obstacle;
    else this.obstacles.push(obstacle);
  }

  removeObstacle(id: string): void {
    const index = this.obstacles.findIndex((o) => o.id === id);
    if (index >= 0) this.obstacles.splice(index, 1);
  }

  clearObstacles(): void {
    this.obstacles.length = 0;
  }

  spawnHumanoid(id: string, x: number, y: number, z: number, scale = 1): Ragdoll {
    const ragdoll = Ragdoll.humanoid(id, x, y, z, scale, this.ragdollOptions);
    this.attachRagdoll(id, ragdoll);
    return ragdoll;
  }

  spawnRope(
    id: string,
    x: number,
    y: number,
    z: number,
    segments = 8,
    segmentLength = 0.4,
  ): Ragdoll {
    const rope = Ragdoll.rope(id, x, y, z, segments, segmentLength, this.ragdollOptions);
    this.attachRagdoll(id, rope);
    return rope;
  }

  /** 重复 id 覆盖旧实例，顺序位置保持不变（覆盖语义，不是重排）。 */
  private attachRagdoll(id: string, ragdoll: Ragdoll): void {
    const existing = this.ragdolls.get(id);
    this.ragdolls.set(id, ragdoll);
    if (existing === undefined) {
      this.ragdollOrder.push(ragdoll);
      return;
    }
    const at = this.ragdollOrder.indexOf(existing);
    if (at >= 0) this.ragdollOrder[at] = ragdoll;
    else this.ragdollOrder.push(ragdoll);
  }

  getRagdoll(id: string): Ragdoll | null {
    return this.ragdolls.get(id) ?? null;
  }

  removeRagdoll(id: string): void {
    const existing = this.ragdolls.get(id);
    if (existing === undefined) return;
    this.ragdolls.delete(id);
    const at = this.ragdollOrder.indexOf(existing);
    if (at >= 0) this.ragdollOrder.splice(at, 1);
  }

  /** 稳定步进顺序（渲染层遍历请用这个，不要遍历 Map）。 */
  getRagdollOrder(): readonly Ragdoll[] {
    return this.ragdollOrder;
  }

  getRagdolls(): ReadonlyMap<string, Ragdoll> {
    return this.ragdolls;
  }

  addPendulum(id: string, config: PendulumConfig): Pendulum {
    const pendulum = new Pendulum({ ...config, gravity: config.gravity ?? this.gravity });
    const existing = this.pendulums.get(id);
    this.pendulums.set(id, pendulum);
    if (existing === undefined) this.pendulumOrder.push(pendulum);
    else {
      const at = this.pendulumOrder.indexOf(existing);
      if (at >= 0) this.pendulumOrder[at] = pendulum;
      else this.pendulumOrder.push(pendulum);
    }
    return pendulum;
  }

  removePendulum(id: string): void {
    const existing = this.pendulums.get(id);
    if (existing === undefined) return;
    this.pendulums.delete(id);
    const at = this.pendulumOrder.indexOf(existing);
    if (at >= 0) this.pendulumOrder.splice(at, 1);
  }

  getPendulumOrder(): readonly Pendulum[] {
    return this.pendulumOrder;
  }

  getPendulum(id: string): Pendulum | null {
    return this.pendulums.get(id) ?? null;
  }

  getPendulums(): ReadonlyMap<string, Pendulum> {
    return this.pendulums;
  }

  step(dt: number): void {
    const t0 = now();
    this.fluid?.step(dt, this.obstacles);
    for (let i = 0; i < this.ragdollOrder.length; i += 1) {
      this.ragdollOrder[i]?.step(dt, this.obstacles);
    }
    for (let i = 0; i < this.pendulumOrder.length; i += 1) {
      this.pendulumOrder[i]?.step(dt);
    }
    this.smoke.step(dt);
    this.simulationTime += dt;
    this.lastStepMs = now() - t0;
  }

  getStats(): PhysicsStats {
    return {
      fluidCount: this.fluid?.count ?? 0,
      smokeCount: this.smoke.count,
      ragdollCount: this.ragdolls.size,
      obstacleCount: this.obstacles.length,
      simulationTime: this.simulationTime,
      lastStepMs: this.lastStepMs,
    };
  }

  get elapsedSeconds(): number {
    return this.simulationTime;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
