import { SYSTEM_PHASES, type FrameInfo, type SystemPhase } from './types.js';

/**
 * 引擎系统。所有可变状态由系统自己持有，注册表只负责按阶段调度。
 * 泛型 TContext 让 core 包不知道 Engine 的存在（core 不依赖任何上层包）。
 */
export interface System<TContext> {
  readonly name: string;
  readonly phase: SystemPhase;
  /** 同阶段内的执行顺序，越小越先；缺省为 0。 */
  readonly order?: number;
  init?(ctx: TContext): void;
  /** 固定步长逻辑（物理/经济模拟）。dt 恒定，保证确定性。 */
  fixedUpdate?(ctx: TContext, dt: number, frame: FrameInfo): void;
  /** 每帧逻辑，dt 为真实帧间隔。 */
  update?(ctx: TContext, dt: number, frame: FrameInfo): void;
  /** 渲染提交。同一帧内 alpha 相同。 */
  render?(ctx: TContext, alpha: number, frame: FrameInfo): void;
  dispose?(ctx: TContext): void;
}

interface Slot<TContext> {
  readonly system: System<TContext>;
  readonly seq: number;
  enabled: boolean;
}

export class SystemRegistry<TContext> {
  private readonly byPhase = new Map<SystemPhase, Slot<TContext>[]>();
  private readonly byName = new Map<string, Slot<TContext>>();
  private seq = 0;

  constructor() {
    for (const phase of SYSTEM_PHASES) {
      this.byPhase.set(phase, []);
    }
  }

  add(system: System<TContext>): this {
    if (this.byName.has(system.name)) {
      throw new Error(`[tabby/core] 系统名重复注册: ${system.name}`);
    }
    const slot: Slot<TContext> = { system, seq: this.seq++, enabled: true };
    this.byName.set(system.name, slot);
    const list = this.byPhase.get(system.phase);
    if (list === undefined) {
      throw new Error(`[tabby/core] 未知阶段: ${system.phase}`);
    }
    list.push(slot);
    list.sort((a, b) => (a.system.order ?? 0) - (b.system.order ?? 0) || a.seq - b.seq);
    return this;
  }

  get<T extends System<TContext>>(name: string): T | null {
    const slot = this.byName.get(name);
    return slot === undefined ? null : (slot.system as T);
  }

  setEnabled(name: string, enabled: boolean): void {
    const slot = this.byName.get(name);
    if (slot !== undefined) slot.enabled = enabled;
  }

  remove(name: string, ctx: TContext): boolean {
    const slot = this.byName.get(name);
    if (slot === undefined) return false;
    slot.system.dispose?.(ctx);
    this.byName.delete(name);
    const list = this.byPhase.get(slot.system.phase);
    if (list !== undefined) {
      const index = list.indexOf(slot);
      if (index >= 0) list.splice(index, 1);
    }
    return true;
  }

  initAll(ctx: TContext): void {
    for (const phase of SYSTEM_PHASES) {
      for (const slot of this.byPhase.get(phase) ?? []) {
        slot.system.init?.(ctx);
      }
    }
  }

  runFixed(ctx: TContext, dt: number, frame: FrameInfo): void {
    for (const slot of this.byPhase.get('physics') ?? []) {
      if (slot.enabled) slot.system.fixedUpdate?.(ctx, dt, frame);
    }
  }

  runPhase(ctx: TContext, phase: SystemPhase, dt: number, alpha: number, frame: FrameInfo): void {
    for (const slot of this.byPhase.get(phase) ?? []) {
      if (!slot.enabled) continue;
      if (phase === 'render') slot.system.render?.(ctx, alpha, frame);
      else if (phase === 'physics') slot.system.fixedUpdate?.(ctx, dt, frame);
      else slot.system.update?.(ctx, dt, frame);
    }
  }

  disposeAll(ctx: TContext): void {
    for (const phase of SYSTEM_PHASES) {
      for (const slot of this.byPhase.get(phase) ?? []) {
        slot.system.dispose?.(ctx);
      }
    }
    this.byPhase.forEach((list) => list.length = 0);
    this.byName.clear();
  }

  get size(): number {
    return this.byName.size;
  }
}
