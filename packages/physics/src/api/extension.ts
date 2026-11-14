import type { PhysicsBounds } from '../types.js';
import type { Ragdoll } from '../ragdoll.js';

/**
 * 半开源 API — Extension 层。
 *
 * 三层划分（P09）：
 *
 * | 层 | 入口 | 稳定性承诺 |
 * |---|---|---|
 * | Public | `@tabby/physics`（`api/public.ts`） | semver 保护，破坏性变更只在大版本 |
 * | Extension | `@tabby/physics/extension`（本文件） | 次版本可加字段，不加必填 |
 * | Internal | 源码内 `@internal` 标记 | 无承诺，`stripInternal` 会从 .d.ts 剔除 |
 *
 * 为什么把 Extension 单独开一个入口：
 * 插件作者需要 `ForceField` / `PhysicsPlugin` 这些抽象，但业务代码不需要。
 * 分成两个入口后，业务包不会被插件类型污染，tree-shaking 也能整块去掉。
 *
 * 本文件不 import 任何实现（只 import 类型），因此不会与 world.ts 形成循环依赖。
 */

// ─────────────────────────── 事件 ───────────────────────────

export interface BodySleepEvent {
  readonly ragdollId: string;
}

export interface BodyWakeEvent {
  readonly ragdollId: string;
}

/**
 * 碰撞事件。
 *
 * **只在「开始接触」时发一次**，不是每帧都发。一个布娃娃躺在地上，
 * 9 个点每帧都要和地面判定，如果按接触发事件，60fps 下就是 540 次/秒。
 * 只在接触状态 0→1 时发，稳态下每秒只有几次。
 */
export interface CollisionEvent {
  readonly ragdollId: string;
  readonly pointIndex: number;
  /** null 表示地面。 */
  readonly obstacleId: string | null;
  /** 推出面：0:+x 1:-x 2:+y 3:-y 4:+z 5:-z。 */
  readonly face: number;
}

export interface LiquidOverflowEvent {
  readonly cellIndex: number;
  /** 溢出时的液面高度（米）。 */
  readonly height: number;
  /** 本步溢出的体积（立方米）。 */
  readonly volume: number;
}

export interface StepEvent {
  readonly dt: number;
  readonly ms: number;
  readonly sleepingRagdolls: number;
}

export interface PluginErrorEvent {
  readonly plugin: string;
  readonly hook: string;
  readonly error: unknown;
}

export interface EventsDroppedEvent {
  readonly count: number;
}

/** 事件表。新增事件必须同时在这里登记，否则 emit 无法通过类型检查。 */
export interface PhysicsEventMap {
  readonly bodySleep: BodySleepEvent;
  readonly bodyWake: BodyWakeEvent;
  readonly collision: CollisionEvent;
  readonly liquidOverflow: LiquidOverflowEvent;
  readonly step: StepEvent;
  readonly pluginError: PluginErrorEvent;
  readonly eventsDropped: EventsDroppedEvent;
}

/** 事件处理函数。导出是为了让 TypeDoc 能完成交叉引用，也方便下游写工具函数。 */
export type EventHandler<T> = (event: T) => void;

/**
 * 类型安全的事件总线。
 *
 * 三条约束：
 * 1. `emit` 的 payload 由事件表推导，写错字段编译期就报错；
 * 2. 监听器数组倒序遍历，允许在回调里 `off` 自己而不跳过下一个监听器；
 * 3. 高频事件走 `emitSampled`，一步之内最多发 N 次，超出部分计数，
 *    步末通过 `eventsDropped` 汇总 —— 宁可丢样本，也不能让事件把帧预算吃穿。
 */
export class PhysicsEventBus {
  private readonly handlers = new Map<string, Array<EventHandler<never>>>();
  private readonly sampledCount = new Map<string, number>();
  private dropped = 0;

  on<K extends keyof PhysicsEventMap>(type: K, handler: EventHandler<PhysicsEventMap[K]>): () => void {
    const key = type as string;
    let list = this.handlers.get(key);
    if (list === undefined) {
      list = [];
      this.handlers.set(key, list);
    }
    list.push(handler as EventHandler<never>);
    return () => this.off(type, handler);
  }

  once<K extends keyof PhysicsEventMap>(type: K, handler: EventHandler<PhysicsEventMap[K]>): () => void {
    const off = this.on(type, (event) => {
      off();
      handler(event);
    });
    return off;
  }

  off<K extends keyof PhysicsEventMap>(type: K, handler: EventHandler<PhysicsEventMap[K]>): void {
    const list = this.handlers.get(type as string);
    if (list === undefined) return;
    const at = list.indexOf(handler as EventHandler<never>);
    if (at >= 0) list.splice(at, 1);
  }

  emit<K extends keyof PhysicsEventMap>(type: K, event: PhysicsEventMap[K]): void {
    const list = this.handlers.get(type as string);
    if (list === undefined || list.length === 0) return;
    // 倒序：回调里 off 自己时，后面的元素索引不受影响
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const handler = list[i];
      if (handler === undefined) continue;
      handler(event as never);
    }
  }

  /**
   * 采样发射。同一步内超过 `budget` 次的部分被丢弃计数。
   *
   * 每个物理步结束由 world 调 `resetSampling()`，所以预算的粒度是「一步」而不是「一秒」，
   * 这样低帧率时事件量按步数缩放，不会因为掉帧突然爆发。
   */
  emitSampled<K extends keyof PhysicsEventMap>(type: K, event: PhysicsEventMap[K], budget = 8): void {
    const key = type as string;
    const used = this.sampledCount.get(key) ?? 0;
    if (used >= budget) {
      this.dropped += 1;
      return;
    }
    this.sampledCount.set(key, used + 1);
    this.emit(type, event);
  }

  /** 每步结束调用。返回并清零本步被丢弃的事件数。 */
  resetSampling(): number {
    if (this.sampledCount.size > 0) this.sampledCount.clear();
    const n = this.dropped;
    this.dropped = 0;
    return n;
  }

  listenerCount(type: keyof PhysicsEventMap): number {
    return this.handlers.get(type as string)?.length ?? 0;
  }

  clear(): void {
    this.handlers.clear();
    this.sampledCount.clear();
    this.dropped = 0;
  }
}

// ─────────────────────────── 力场与约束 ───────────────────────────

/**
 * 力场作用的上下文。
 *
 * 只给只读的世界视图 + 布娃娃数组。插件**不能**直接改 positions：
 * 位置必须由约束求解器统一维护，否则自定义力会和距离约束打架，
 * 表现为布娃娃被拉长或炸开。
 * 施加加速度请用 `ragdoll.addAcceleration()`，它走的是 Verlet 的合法路径。
 */
export interface ForceContext {
  readonly bounds: PhysicsBounds;
  readonly time: number;
  readonly ragdolls: readonly Ragdoll[];
}

export interface ForceField {
  readonly id: string;
  /** 每步调用一次。实现里应自己跳过 `ragdoll.isAsleep` 的对象。 */
  apply(ctx: ForceContext, dt: number): void;
  dispose?(): void;
}

export interface ConstraintContext {
  readonly bounds: PhysicsBounds;
  readonly time: number;
  readonly ragdolls: readonly Ragdoll[];
}

export interface CustomConstraint {
  readonly id: string;
  /** 每步在所有布娃娃步进之后调用一次。 */
  solve(ctx: ConstraintContext): void;
  dispose?(): void;
}

export interface RegistryOptions {
  /** 同名重复注册时的行为，默认 'replace'。 */
  readonly onDuplicate?: 'replace' | 'ignore' | 'error';
}

/**
 * 力场注册表。
 *
 * 排序规则：priority 大的先执行，同优先级按注册顺序。
 * 稳定顺序很重要 —— 风场与爆炸力的叠加在浮点上不满足交换律，
 * 顺序一变，回放就对不上。
 */
export class ForceFieldRegistry {
  private readonly fields: ForceField[] = [];
  private readonly priorities: number[] = [];
  private readonly options: RegistryOptions;

  constructor(options: RegistryOptions = {}) {
    this.options = options;
  }

  get size(): number {
    return this.fields.length;
  }

  add(field: ForceField, priority = 0): void {
    const at = this.fields.findIndex((f) => f.id === field.id);
    if (at >= 0) {
      const mode = this.options.onDuplicate ?? 'replace';
      if (mode === 'ignore') return;
      if (mode === 'error') throw new Error(`[tabby/physics] 力场 id 重复：${field.id}`);
      this.fields.splice(at, 1);
      this.priorities.splice(at, 1);
    }
    let insert = this.fields.length;
    for (let i = 0; i < this.priorities.length; i += 1) {
      if ((this.priorities[i] as number) < priority) {
        insert = i;
        break;
      }
    }
    this.fields.splice(insert, 0, field);
    this.priorities.splice(insert, 0, priority);
  }

  remove(id: string): boolean {
    const at = this.fields.findIndex((f) => f.id === id);
    if (at < 0) return false;
    this.fields[at]?.dispose?.();
    this.fields.splice(at, 1);
    this.priorities.splice(at, 1);
    return true;
  }

  clear(): void {
    for (const field of this.fields) field.dispose?.();
    this.fields.length = 0;
    this.priorities.length = 0;
  }

  apply(ctx: ForceContext, dt: number): void {
    for (let i = 0; i < this.fields.length; i += 1) {
      this.fields[i]?.apply(ctx, dt);
    }
  }

  list(): readonly string[] {
    return this.fields.map((f) => f.id);
  }
}

/** 自定义约束注册表，语义与力场一致。 */
export class ConstraintRegistry {
  private readonly constraints: CustomConstraint[] = [];
  private readonly options: RegistryOptions;

  constructor(options: RegistryOptions = {}) {
    this.options = options;
  }

  get size(): number {
    return this.constraints.length;
  }

  add(constraint: CustomConstraint, priority = 0): void {
    const at = this.constraints.findIndex((c) => c.id === constraint.id);
    if (at >= 0) {
      const mode = this.options.onDuplicate ?? 'replace';
      if (mode === 'ignore') return;
      if (mode === 'error') throw new Error(`[tabby/physics] 约束 id 重复：${constraint.id}`);
      this.constraints.splice(at, 1);
    }
    if (priority >= 0 || at < 0) this.constraints.push(constraint);
    else this.constraints.unshift(constraint);
  }

  remove(id: string): boolean {
    const at = this.constraints.findIndex((c) => c.id === id);
    if (at < 0) return false;
    this.constraints[at]?.dispose?.();
    this.constraints.splice(at, 1);
    return true;
  }

  clear(): void {
    for (const c of this.constraints) c.dispose?.();
    this.constraints.length = 0;
  }

  solve(ctx: ConstraintContext): void {
    for (let i = 0; i < this.constraints.length; i += 1) {
      this.constraints[i]?.solve(ctx);
    }
  }

  list(): readonly string[] {
    return this.constraints.map((c) => c.id);
  }
}

// ─────────────────────────── 插件 ───────────────────────────

/** 插件拿到的世界视图。故意不含 `world.step` 与障碍物写入 —— 插件不该改世界。 */
export interface PluginWorldView {
  readonly bounds: PhysicsBounds;
  readonly time: number;
  readonly ragdolls: readonly Ragdoll[];
  readonly events: PhysicsEventBus;
  readonly forces: ForceFieldRegistry;
  readonly constraints: ConstraintRegistry;
}

export interface PhysicsPlugin {
  readonly name: string;
  /** 世界就绪后调用一次，通常在这里注册力场/约束。 */
  register(world: PluginWorldView): void;
  onBeforeStep?(world: PluginWorldView, dt: number): void;
  onAfterStep?(world: PluginWorldView, dt: number): void;
  dispose?(): void;
}

/**
 * 插件宿主。
 *
 * 每个钩子都单独 try/catch：一个插件抛异常不能把整个物理世界带崩。
 * 移动端没有崩溃崩溃面板，插件错误只能靠 `pluginError` 事件上报到诊断层，
 * 所以这里宁可吞掉异常也要继续跑 —— 但要如实上报，不能静默。
 */
export class PluginHost {
  private readonly plugins: PhysicsPlugin[] = [];
  private readonly bus: PhysicsEventBus;

  constructor(bus: PhysicsEventBus) {
    this.bus = bus;
  }

  get names(): readonly string[] {
    return this.plugins.map((p) => p.name);
  }

  add(plugin: PhysicsPlugin, view: PluginWorldView): void {
    const exists = this.plugins.findIndex((p) => p.name === plugin.name);
    if (exists >= 0) throw new Error(`[tabby/physics] 插件重名：${plugin.name}`);
    try {
      plugin.register?.(view);
    } catch (error) {
      this.report(plugin.name, 'register', error);
      return;
    }
    this.plugins.push(plugin);
  }

  remove(name: string): boolean {
    const at = this.plugins.findIndex((p) => p.name === name);
    if (at < 0) return false;
    const plugin = this.plugins[at];
    try {
      plugin?.dispose?.();
    } catch (error) {
      this.report(name, 'dispose', error);
    }
    this.plugins.splice(at, 1);
    return true;
  }

  beforeStep(view: PluginWorldView, dt: number): void {
    for (let i = 0; i < this.plugins.length; i += 1) {
      const plugin = this.plugins[i];
      if (plugin?.onBeforeStep === undefined) continue;
      try {
        plugin.onBeforeStep(view, dt);
      } catch (error) {
        this.report(plugin.name, 'onBeforeStep', error);
      }
    }
  }

  afterStep(view: PluginWorldView, dt: number): void {
    for (let i = 0; i < this.plugins.length; i += 1) {
      const plugin = this.plugins[i];
      if (plugin?.onAfterStep === undefined) continue;
      try {
        plugin.onAfterStep(view, dt);
      } catch (error) {
        this.report(plugin.name, 'onAfterStep', error);
      }
    }
  }

  disposeAll(): void {
    for (const plugin of this.plugins) {
      try {
        plugin.dispose?.();
      } catch (error) {
        this.report(plugin.name, 'dispose', error);
      }
    }
    this.plugins.length = 0;
  }

  private report(plugin: string, hook: string, error: unknown): void {
    this.bus.emit('pluginError', { plugin, hook, error });
  }
}
