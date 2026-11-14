import type { Engine } from '@tabby/engine';
import { gsap } from 'gsap';

export interface AnimationSystemOptions {
  /** 全局时间缩放，0 表示暂停（配合引擎暂停）。 */
  readonly timeScale?: number;
  /** 尊重系统的「减少动态效果」设置：把时长压到几乎为 0。 */
  readonly respectReducedMotion?: boolean;
}

/**
 * GSAP 适配层。
 *
 * 为什么不自己接管 gsap.ticker：GSAP 的 ticker 内部已做 lagSmoothing、
 * 页面隐藏暂停、以及「同一帧只推进一次」的合并逻辑，强行改成引擎驱动
 * 反而会与 Vue 的 nextTick 顺序冲突（GSAP 官方也不推荐）。
 *
 * 这里做的是「状态同步」而不是「抢占调度」：
 * - 用 gsap.context() 把动画绑定到引擎生命周期，dispose 时自动 revert；
 * - 引擎暂停（切后台）时暂停时间轴，避免回来一次性跳变；
 * - 系统开启「减少动态效果」时把持续时间压到 1ms，而不是直接禁用（避免逻辑依赖 onComplete）。
 */
export class AnimationSystem {
  readonly name = 'tabby:animation';

  private readonly reducedMotion: boolean;
  private readonly contexts = new Set<gsap.Context>();
  private engine: Engine | null = null;
  private motionScale: number;

  constructor(options: AnimationSystemOptions = {}) {
    this.reducedMotion = options.respectReducedMotion ?? true;
    this.motionScale = options.timeScale ?? 1;
  }

  /** 绑定引擎：暂停/恢复与引擎同步，dispose 时统一清理。 */
  attach(engine: Engine): void {
    this.engine = engine;
    if (this.reducedMotion && engine.caps.reducedMotion) {
      gsap.globalTimeline.timeScale(1);
      this.motionScale = 0;
    }
    engine.bus.on('disposed', () => this.dispose());
  }

  get isReducedMotion(): boolean {
    return this.reducedMotion && (this.engine?.caps.reducedMotion ?? false);
  }

  /** 动画时长修正：减少动态效果时几乎瞬时。 */
  duration(seconds: number): number {
    return this.isReducedMotion ? 0.001 : seconds * this.motionScale;
  }

  to(target: object, vars: gsap.TweenVars): gsap.core.Tween {
    return gsap.to(target, { ...vars, duration: this.resolveDuration(vars.duration, 0.4) });
  }

  from(target: object, vars: gsap.TweenVars): gsap.core.Tween {
    return gsap.from(target, { ...vars, duration: this.resolveDuration(vars.duration, 0.4) });
  }

  fromTo(target: object, fromVars: gsap.TweenVars, toVars: gsap.TweenVars): gsap.core.Tween {
    return gsap.fromTo(target, fromVars, {
      ...toVars,
      duration: this.resolveDuration(toVars.duration, 0.4),
    });
  }

  private resolveDuration(value: gsap.TweenValue | undefined, fallback: number): number {
    return this.duration(typeof value === 'number' ? value : fallback);
  }

  timeline(vars: gsap.TimelineVars = {}): gsap.core.Timeline {
    return gsap.timeline(vars);
  }

  set(target: object, vars: gsap.TweenVars): gsap.core.Tween {
    return gsap.set(target, vars);
  }

  /** 受管上下文：回调里创建的动画会在 dispose 时自动回收。 */
  context(scope: () => void): gsap.Context {
    const ctx = gsap.context(scope);
    this.contexts.add(ctx);
    return ctx;
  }

  /**
   * 数值补间（HUD 数字滚动、进度条）。
   * 用对象包装而不是 gsap.to(number)，因为 GSAP 不支持直接对原始值补间。
   */
  number(
    from: number,
    to: number,
    seconds: number,
    onUpdate: (value: number) => void,
    ease = 'power2.out',
  ): gsap.core.Tween {
    const proxy = { value: from };
    return gsap.to(proxy, {
      value: to,
      duration: this.duration(seconds),
      ease,
      onUpdate: () => onUpdate(proxy.value),
    });
  }

  pause(): void {
    gsap.globalTimeline.pause();
  }

  resume(): void {
    gsap.globalTimeline.resume();
  }

  /** 立即杀掉全部补间（场景切换用）。 */
  killAll(): void {
    for (const ctx of this.contexts) ctx.revert();
    this.contexts.clear();
    gsap.globalTimeline.clear();
  }

  dispose(): void {
    this.killAll();
    this.engine = null;
  }
}
