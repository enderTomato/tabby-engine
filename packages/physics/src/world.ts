import {
  ConstraintRegistry,
  ForceFieldRegistry,
  PhysicsEventBus,
  PluginHost,
  type CustomConstraint,
  type ForceField,
  type PhysicsPlugin,
  type PluginWorldView,
} from './api/extension.js';
import { FluidSolver } from './fluid.js';
import { LiquidSystem, type LiquidOptions } from './liquid.js';
import { DoublePendulum, type DoublePendulumConfig } from './pendulum-chain.js';
import { Pendulum, type PendulumConfig } from './pendulum.js';
import { Ragdoll } from './ragdoll.js';
import { SmokeSystem } from './smoke.js';
import { ObstacleGrid } from './spatial-hash.js';
import { WindField } from './wind.js';
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
  readonly liquid?: Partial<LiquidOptions> | null;
  readonly smoke?: Partial<SmokeOptions> | null;
  readonly ragdoll?: Partial<RagdollOptions>;
  /** 风场参数，摆动与烟雾共享同一个实例。 */
  readonly wind?: Partial<import('./wind.js').WindConfig>;
  /** 宽相位网格边长，建议取典型障碍物尺寸。 */
  readonly gridCellSize?: number;
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
  /** 高度场液面（模拟层）。`fluid` 是表现层粒子，两者可以同时存在。 */
  readonly liquid: LiquidSystem | null;
  readonly smoke: SmokeSystem;
  readonly wind: WindField;
  readonly obstacles: Obstacle[] = [];

  private readonly ragdolls = new Map<string, Ragdoll>();
  private readonly pendulums = new Map<string, Pendulum>();
  private readonly doublePendulums = new Map<string, DoublePendulum>();
  /**
   * 步进顺序用显式数组，不遍历 Map。
   * JS 的 Map 虽然是插入序，但「依赖容器序」本身是确定性红线（P04 §7 / P18 §6）：
   * 一旦有人为了释放内存先删再插，顺序就变了，存档回放会跨设备对不上。
   * 数组顺序由本类显式维护，增删都可审计。
   */
  private readonly ragdollOrder: Ragdoll[] = [];
  private readonly pendulumOrder: Pendulum[] = [];
  private readonly doublePendulumOrder: DoublePendulum[] = [];
  private readonly ragdollOptions: RagdollOptions;
  /**
   * 障碍物宽相位。只在 obstacles 变化时重建 —— 建筑是静态的，
   * 每帧重建会让本来省下来的开销又还回去。
   */
  private readonly grid: ObstacleGrid;
  private lastStepMs = 0;
  private simulationTime = 0;

  // ── Extension 层：事件、力场、自定义约束、插件 ──
  readonly events = new PhysicsEventBus();
  readonly forces = new ForceFieldRegistry();
  readonly constraints = new ConstraintRegistry();
  readonly plugins: PluginHost;
  /**
   * 传给插件与力场的上下文对象。
   *
   * 用 getter 而不是每帧构造新对象：`{...world}` 看起来无害，
   * 但物理是每一步都跑（60 步/秒），每步一个对象字面量对 GC 是实打实的压力。
   * 而且旧对象被插件持有时会读到过期数据 —— 这是更隐蔽的坑。
   */
  private readonly pluginView: PluginWorldView;
  private readonly forceContext: { readonly bounds: PhysicsBounds; readonly time: number; readonly ragdolls: readonly Ragdoll[] };

  constructor(options: PhysicsWorldOptions = {}) {
    this.gravity = options.gravity ?? 9.8;
    this.fixedDt = options.fixedDt ?? 1 / 60;
    this.bounds = options.bounds ?? DEFAULT_BOUNDS;
    this.wind = new WindField(options.wind ?? {});
    this.grid = new ObstacleGrid(options.gridCellSize ?? 2);

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

    this.liquid =
      options.liquid === null
        ? null
        : new LiquidSystem({
            gravity: this.gravity,
            originX: this.bounds.min.x,
            originZ: this.bounds.min.z,
            ...options.liquid,
          });

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
    this.smoke.setWind(this.wind);

    this.ragdollOptions = {
      gravity: this.gravity * 0.9,
      damping: 0.995,
      iterations: 4,
      groundY: this.bounds.min.y,
      friction: 0.35,
      bounds: this.bounds,
      ...options.ragdoll,
    };

    this.plugins = new PluginHost(this.events);
    if (this.liquid !== null) {
      const bus = this.events;
      this.liquid.onOverflow = (overflow) => {
        bus.emitSampled(
          'liquidOverflow',
          { cellIndex: overflow.cellIndex, height: overflow.height, volume: overflow.volume },
          4,
        );
      };
    }
    const self = this;
    this.pluginView = {
      get bounds(): PhysicsBounds {
        return self.bounds;
      },
      get time(): number {
        return self.simulationTime;
      },
      get ragdolls(): readonly Ragdoll[] {
        return self.ragdollOrder;
      },
      events: this.events,
      forces: this.forces,
      constraints: this.constraints,
    };
    this.forceContext = {
      get bounds(): PhysicsBounds {
        return self.bounds;
      },
      get time(): number {
        return self.simulationTime;
      },
      get ragdolls(): readonly Ragdoll[] {
        return self.ragdollOrder;
      },
    };
  }

  /** 注册插件。register 抛异常会被隔离成 pluginError 事件，不会带崩世界。 */
  use(plugin: PhysicsPlugin): this {
    this.plugins.add(plugin, this.pluginView);
    return this;
  }

  /** 添加力场（风、爆炸、自定义）。 */
  addForceField(field: ForceField, priority = 0): void {
    this.forces.add(field, priority);
  }

  /** 添加自定义约束。 */
  addConstraint(constraint: CustomConstraint, priority = 0): void {
    this.constraints.add(constraint, priority);
  }

  addObstacle(obstacle: Obstacle): void {
    const index = this.obstacles.findIndex((o) => o.id === obstacle.id);
    if (index >= 0) this.obstacles[index] = obstacle;
    else this.obstacles.push(obstacle);
    this.onObstaclesChanged();
  }

  removeObstacle(id: string): void {
    const index = this.obstacles.findIndex((o) => o.id === id);
    if (index >= 0) {
      this.obstacles.splice(index, 1);
      this.onObstaclesChanged();
    }
  }

  clearObstacles(): void {
    this.obstacles.length = 0;
    this.onObstaclesChanged();
  }

  /**
   * 障碍物变了：重建网格，并唤醒所有沉睡的布娃娃。
   *
   * 不唤醒的话会出现「墙拆了，布娃娃还悬在半空」—— 它因为贴墙静止已进入休眠，
   * 没人叫它重新积分。
   */
  private onObstaclesChanged(): void {
    this.grid.rebuild(this.obstacles);
    for (let i = 0; i < this.ragdollOrder.length; i += 1) {
      this.ragdollOrder[i]?.wake();
    }
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
    const bus = this.events;
    const ragdollId = id;
    ragdoll.onContact = (pointIndex, obstacleId, face) => {
      bus.emitSampled('collision', { ragdollId, pointIndex, obstacleId, face });
    };
    ragdoll.onSleepChange = (asleep) => {
      bus.emit(asleep ? 'bodySleep' : 'bodyWake', { ragdollId });
    };

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

  /** 唤醒全部布娃娃（例如玩家在场景里投掷物体、或时间跳变后）。 */
  wakeAllRagdolls(): void {
    for (let i = 0; i < this.ragdollOrder.length; i += 1) {
      this.ragdollOrder[i]?.wake();
    }
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

  addDoublePendulum(id: string, config: DoublePendulumConfig): DoublePendulum {
    const instance = new DoublePendulum(config);
    const existing = this.doublePendulums.get(id);
    this.doublePendulums.set(id, instance);
    if (existing === undefined) this.doublePendulumOrder.push(instance);
    else {
      const at = this.doublePendulumOrder.indexOf(existing);
      if (at >= 0) this.doublePendulumOrder[at] = instance;
      else this.doublePendulumOrder.push(instance);
    }
    return instance;
  }

  removeDoublePendulum(id: string): void {
    const existing = this.doublePendulums.get(id);
    if (existing === undefined) return;
    this.doublePendulums.delete(id);
    const at = this.doublePendulumOrder.indexOf(existing);
    if (at >= 0) this.doublePendulumOrder.splice(at, 1);
  }

  getDoublePendulumOrder(): readonly DoublePendulum[] {
    return this.doublePendulumOrder;
  }

  getDoublePendulum(id: string): DoublePendulum | null {
    return this.doublePendulums.get(id) ?? null;
  }

  /**
   * 一步物理。
   *
   * 顺序是契约，不是实现细节：
   *
   *   plugin.onBeforeStep  → 外力（风/爆炸）→ 积分与约束 → 自定义约束 → plugin.onAfterStep
   *
   * 外力必须在积分之前，否则这一帧的力要等到下一帧才生效（视觉上慢一拍）；
   * 自定义约束放在内置约束之后，保证它们基于已经解过穿透的位置做二次修正，
   * 否则自定义约束会被内置求解器覆盖掉。
   */
  step(dt: number): void {
    const t0 = now();
    this.plugins.beforeStep(this.pluginView, dt);

    if (this.forces.size > 0) this.forces.apply(this.forceContext, dt);

    this.fluid?.step(dt, this.obstacles);
    this.liquid?.step(dt);
    for (let i = 0; i < this.ragdollOrder.length; i += 1) {
      this.ragdollOrder[i]?.step(dt, this.obstacles, this.grid);
    }
    for (let i = 0; i < this.pendulumOrder.length; i += 1) {
      this.pendulumOrder[i]?.step(dt);
    }
    for (let i = 0; i < this.doublePendulumOrder.length; i += 1) {
      this.doublePendulumOrder[i]?.step(dt);
    }
    this.smoke.step(dt);

    if (this.constraints.size > 0) this.constraints.solve(this.forceContext);

    this.simulationTime += dt;
    this.lastStepMs = now() - t0;

    this.plugins.afterStep(this.pluginView, dt);

    const dropped = this.events.resetSampling();
    if (dropped > 0) this.events.emit('eventsDropped', { count: dropped });
  }

  getStats(): PhysicsStats {
    let sleeping = 0;
    for (let i = 0; i < this.ragdollOrder.length; i += 1) {
      if (this.ragdollOrder[i]?.isAsleep === true) sleeping += 1;
    }
    return {
      fluidCount: this.fluid?.count ?? 0,
      smokeCount: this.smoke.count,
      ragdollCount: this.ragdolls.size,
      sleepingRagdolls: sleeping,
      obstacleCount: this.obstacles.length,
      gridInstances: this.grid.instances,
      gridDegraded: this.grid.degraded,
      simulationTime: this.simulationTime,
      lastStepMs: this.lastStepMs,
    };
  }

  /**
   * @internal
   * 宽相位网格的内部统计，供诊断面板使用。
   * 不放进公开 API 的原因：字段会随网格实现变化，承诺稳定没有意义。
   */
  getGridStats(): { cells: number; instances: number; degraded: boolean } {
    return { cells: this.grid.cellCount, instances: this.grid.instances, degraded: this.grid.degraded };
  }

  get elapsedSeconds(): number {
    return this.simulationTime;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
