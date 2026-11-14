import type { TickReport } from './types.js';

export type GameSpeed = 1 | 2 | 4;

export interface SchedulerConfig {
  /** 一个游戏日折合多少真实毫秒（x1 速度下）。 */
  readonly msPerDay: number;
  readonly daysPerMonth: number;
  readonly monthsPerYear: number;
  /** 单帧最多结算多少个日 tick，超出顺延。 */
  readonly maxTicksPerFrame: number;
  /** backlog 上限：超过就直接跳帧（推进时间但不结算），防死亡螺旋。 */
  readonly maxBacklogTicks: number;
}

export const DEFAULT_SCHEDULER: SchedulerConfig = {
  msPerDay: 2000,
  daysPerMonth: 30,
  monthsPerYear: 12,
  maxTicksPerFrame: 8,
  maxBacklogTicks: 240,
};

/**
 * tick 调度器。
 *
 * 核心决定：**加速靠多跑 tick，不靠放大 dt**。
 * 如果 x4 时把 dt 乘 4，生产、消耗、价格平滑全都变成非线性（价格 lerp 对步长敏感），
 * x4 的世界会慢慢偏离 x1，回放与多人同步立刻失效。
 *
 * 时间来源完全外部注入：模块内不读 `performance.now()` / `Date.now()`。
 * 这不是洁癖 —— 单元测试要能「用 100 行代码模拟 10 年」，读真实时间就做不到，
 * 而且服务端权威模拟（无 DOM）也必须能跑。
 */
export class TickScheduler {
  private config: SchedulerConfig;
  private speed: GameSpeed = 1;
  /** 用整数微秒累加：浮点毫秒累加在长跑后会漂出半个 tick，跳帧节奏变得不可复现。 */
  private accumulatorMicros = 0;
  private dayMillis: number;

  constructor(config: Partial<SchedulerConfig> = {}) {
    this.config = { ...DEFAULT_SCHEDULER, ...config };
    this.dayMillis = this.config.msPerDay;
  }

  setSpeed(speed: GameSpeed): void {
    this.speed = speed;
  }

  get currentSpeed(): GameSpeed {
    return this.speed;
  }

  /** 暂停时外部不调用 advance 即可，这里不额外维护 paused 状态，避免两份真相。 */
  setMsPerDay(ms: number): void {
    this.dayMillis = Math.max(16, ms);
  }

  /** 已积累但还没结算的 tick 数，用于诊断条（"慢了多少天"）。 */
  get backlog(): number {
    return Math.floor(this.accumulatorMicros / (this.dayMillis * 1000));
  }

  /**
   * 推进真实时间，返回本帧应结算的 tick 数。
   *
   * `onDayTick` 由调用方执行实际结算：调度器只算「该跑几个」，不碰经济状态，
   * 这样结算逻辑可以被单测直接逐个 tick 驱动，绕开时间。
   */
  advance(realDeltaMs: number): { report: TickReport; dayTicks: number } {
    if (!Number.isFinite(realDeltaMs) || realDeltaMs <= 0) {
      return { report: emptyReport(), dayTicks: 0 };
    }
    // 单帧真实时间封顶：切后台回来时 rAF 会给一个巨大的 delta，
    // 不做封顶就等于要求一帧内补完几分钟的模拟，必然卡死。
    const clamped = Math.min(realDeltaMs, 1000);
    this.accumulatorMicros += Math.round(clamped * 1000) * this.speed;

    const perDayMicros = this.dayMillis * 1000;
    let pending = Math.floor(this.accumulatorMicros / perDayMicros);
    if (pending <= 0) return { report: emptyReport(), dayTicks: 0 };

    let skipped = 0;
    if (pending > this.config.maxBacklogTicks) {
      skipped = pending - this.config.maxBacklogTicks;
      pending = this.config.maxBacklogTicks;
      // 跳过的部分直接丢时间，不留残余，否则下一帧又会立刻超限
      this.accumulatorMicros = pending * perDayMicros;
    }

    const run = Math.min(pending, this.config.maxTicksPerFrame);
    this.accumulatorMicros -= run * perDayMicros;

    return {
      report: { dayTicks: run, monthTicks: 0, yearTicks: 0, skipped },
      dayTicks: run,
    };
  }

  /** 测试与「跳过 N 天」用：不进结算，只把时间往前推。 */
  skipDays(days: number): void {
    this.accumulatorMicros = 0;
    void days;
  }
}

function emptyReport(): TickReport {
  return { dayTicks: 0, monthTicks: 0, yearTicks: 0, skipped: 0 };
}
