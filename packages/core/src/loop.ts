import type { FrameInfo } from './types.js';

export interface LoopConfig {
  /** 固定步长（秒）。逻辑确定性依赖它恒定。 */
  readonly fixedDt: number;
  /** 单帧最多追多少个固定步，防止「死亡螺旋」。 */
  readonly maxSubSteps: number;
  /** 单帧最大采信时长（毫秒），超出部分直接丢弃（切后台回前台、GC 卡顿）。 */
  readonly maxFrameDeltaMs: number;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  fixedDt: 1 / 60,
  maxSubSteps: 5,
  maxFrameDeltaMs: 100,
};

export interface LoopHooks {
  /** 固定步长回调，dt 恒为 config.fixedDt。 */
  fixed(dt: number, frame: FrameInfo): void;
  /** 每帧一次，用于渲染与 UI 同步。 */
  frame(frame: FrameInfo): void;
}

interface MutableFrameInfo {
  frame: number;
  deltaMs: number;
  elapsedMs: number;
  alpha: number;
  fixedSteps: number;
  droppedMs: number;
}

/**
 * 固定步长主循环（accumulator 模式）。
 *
 * 为什么不用「render 里 dt 直接积分」：模拟经营/生存类需要确定性，
 * 且 Android 上帧间隔抖动极大（热降频、WebView 调度），
 * 变步长会让流体与布娃娃行为在不同机型上不一致。
 */
export class GameLoop {
  private readonly hooks: LoopHooks;
  private readonly config: LoopConfig;
  private readonly fixedDtMs: number;
  private readonly info: MutableFrameInfo = {
    frame: 0,
    deltaMs: 0,
    elapsedMs: 0,
    alpha: 0,
    fixedSteps: 0,
    droppedMs: 0,
  };

  private rafId = 0;
  private running = false;
  private lastNowMs = 0;
  private accumulatorMs = 0;
  private paused = false;
  private readonly raf: (cb: (t: number) => void) => number;
  private readonly cancelRaf: (id: number) => void;

  constructor(hooks: LoopHooks, config: Partial<LoopConfig> = {}) {
    this.hooks = hooks;
    this.config = { ...DEFAULT_LOOP_CONFIG, ...config };
    if (!(this.config.fixedDt > 0)) {
      throw new Error('[tabby/core] fixedDt 必须为正数');
    }
    this.fixedDtMs = this.config.fixedDt * 1000;
    const g = globalThis as unknown as {
      requestAnimationFrame?: (cb: (t: number) => void) => number;
      cancelAnimationFrame?: (id: number) => void;
    };
    this.raf = g.requestAnimationFrame?.bind(globalThis) ?? fallbackRaf;
    this.cancelRaf = g.cancelAnimationFrame?.bind(globalThis) ?? fallbackCancel;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get frameCount(): number {
    return this.info.frame;
  }

  get elapsedMs(): number {
    return this.info.elapsedMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastNowMs = 0;
    this.accumulatorMs = 0;
    this.rafId = this.raf(this.onAnimationFrame);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.cancelRaf(this.rafId);
    this.rafId = 0;
  }

  /** 暂停时 rAF 继续跑（保持 UI 响应），但不推进逻辑时间。 */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.accumulatorMs = 0;
    this.lastNowMs = 0;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** 恢复时丢弃切后台期间累积的时间，避免一次性追帧。 */
  resetClock(): void {
    this.lastNowMs = 0;
    this.accumulatorMs = 0;
  }

  /** 手动驱动一帧（测试 / 非 rAF 环境 / 自建调度器）。 */
  advance(nowMs: number): void {
    const info = this.info;
    const rawDelta = this.lastNowMs === 0 ? 0 : nowMs - this.lastNowMs;
    this.lastNowMs = nowMs;

    if (this.paused) {
      info.deltaMs = 0;
      info.fixedSteps = 0;
      info.droppedMs = 0;
      info.alpha = 0;
      this.hooks.frame(info as FrameInfo);
      info.frame += 1;
      return;
    }

    const deltaMs = Math.min(Math.max(rawDelta, 0), this.config.maxFrameDeltaMs);
    this.accumulatorMs += deltaMs;

    let steps = 0;
    while (this.accumulatorMs >= this.fixedDtMs && steps < this.config.maxSubSteps) {
      this.accumulatorMs -= this.fixedDtMs;
      steps += 1;
      info.fixedSteps = steps;
      info.alpha = 0;
      info.deltaMs = deltaMs;
      info.droppedMs = 0;
      this.hooks.fixed(this.config.fixedDt, info as FrameInfo);
    }

    let droppedMs = 0;
    if (this.accumulatorMs >= this.fixedDtMs) {
      droppedMs = this.accumulatorMs;
      this.accumulatorMs = this.accumulatorMs % this.fixedDtMs;
    }

    info.frame += 1;
    info.deltaMs = deltaMs;
    info.elapsedMs += deltaMs;
    info.fixedSteps = steps;
    info.droppedMs = droppedMs;
    info.alpha = this.accumulatorMs / this.fixedDtMs;
    this.hooks.frame(info as FrameInfo);
  }

  private readonly onAnimationFrame = (nowMs: number): void => {
    if (!this.running) return;
    this.rafId = this.raf(this.onAnimationFrame);
    this.advance(nowMs);
  };
}

function fallbackRaf(cb: (t: number) => void): number {
  return setTimeout(() => cb(performance.now()), 16) as unknown as number;
}

function fallbackCancel(id: number): void {
  clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}
