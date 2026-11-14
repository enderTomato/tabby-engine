/**
 * 探针契约。
 *
 * ## 一个探针是什么
 *
 * 「一个可以被单独观察和测量的特性」。它自己负责挂载 DOM、自己跑循环、
 * 自己给出跑分 —— 外壳只负责切换与显示。
 *
 * ## 为什么 unmount 是必选的
 *
 * 探针之间会互相污染：一个还在跑的 rAF 循环会让下一个探针的帧率看起来很差，
 * 一个没 dispose 的 WebGL 上下文会让浏览器拒绝创建下一个。
 * 所以 `unmount` 不是可选项，切换之前一定会调，且外壳不等它「有空再说」。
 *
 * ## 为什么 tick 是可选的
 *
 * 有些探针是纯计算（图、经济、存档），放一次就出结果，不需要每帧。
 * 给它们一个空的 tick 只会让人以为「这特性是逐帧的」。
 */

/** 跑分里的一行指标。`value` 是字符串，因为一半是「1.2ms」一半是「3/3 通」。 */
export interface MetricLine {
  readonly label: string;
  readonly value: string;
  /** 一句话解释这个数意味着什么，显示在行尾。 */
  readonly hint?: string;
}

export interface BenchResult {
  /** 这一组测量的总耗时（毫秒）。没有可测的东西时省略。 */
  readonly ms?: number;
  readonly lines: readonly MetricLine[];
}

export interface ProbeContext {
  /** 探针自己的容器。切走时整个容器被清空，探针不用自己拆。 */
  readonly host: HTMLElement;
  /** 把指标行推到左下角（每帧刷新时用）。 */
  readonly setStats: (lines: readonly string[]) => void;
  /** 往右下角日志里追加一行（带时间戳）。 */
  readonly log: (message: string) => void;
}

export interface Probe {
  readonly id: string;
  readonly title: string;
  /** 一句话：「这个探针在验什么」。显示在标题下面。 */
  readonly summary: string;
  /** 分组名，用于左侧列表的分隔。 */
  readonly group: string;
  mount(ctx: ProbeContext): void | Promise<void>;
  unmount(): void;
  /** 每帧调用。`dtMs` 已夹在 [0, 100] 内，避免切后台回来的巨大跳变。 */
  tick?(nowMs: number, dtMs: number): void;
  bench?(): BenchResult | Promise<BenchResult>;
}

/** 便于探针统一给出「耗时 → 毫秒字符串」。 */
export function ms(value: number): MetricLine['value'] {
  if (!Number.isFinite(value)) return '—';
  if (value >= 100) return `${value.toFixed(0)}ms`;
  if (value >= 10) return `${value.toFixed(1)}ms`;
  return `${value.toFixed(2)}ms`;
}

/**
 * 批量计时。
 *
 * ## 为什么不能「跑一次、量一次」
 *
 * `performance.now()` 的精度是有限的：Chromium 出于安全（Spectre）考虑把分辨率
 * 钳在 100µs 上下，本机实测约 5µs 一档。而「一次风场采样」「一次 LOD 选择」
 * 只有几十纳秒 —— 单次计时会稳定地返回 0，于是跑分表上出现一片 `0.00µs`，
 * 看上去像探针坏了，实际是尺子不够细。
 *
 * 所以统一改成「跑一批、量总量、再平均」，并把循环本身的开销用空批次扣掉。
 * 这样几纳秒的操作也能给出三位有效数字。
 */
export function timeBatch(run: (index: number) => void, iterations = 2000, warmup = 200): { perCallUs: number; totalMs: number } {
  for (let i = 0; i < warmup; i += 1) run(i);

  // 空循环基线：批次够小的时候，for 循环自身的开销不能忽略
  let emptyMs = 0;
  const emptyRounds = 5;
  for (let round = 0; round < emptyRounds; round += 1) {
    const started = performance.now();
    for (let i = 0; i < iterations; i += 1) void i;
    emptyMs += performance.now() - started;
  }
  emptyMs /= emptyRounds;

  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) run(i);
  const totalMs = performance.now() - started;
  const netMs = Math.max(0, totalMs - emptyMs);
  return { perCallUs: (netMs * 1000) / iterations, totalMs };
}

/** 把 `timeBatch` 的结果直接转成一行指标。 */
export function batchLine(label: string, perCallUs: number, hint: string): MetricLine {
  const value = perCallUs >= 1000 ? `${(perCallUs / 1000).toFixed(2)}ms` : perCallUs >= 10 ? `${perCallUs.toFixed(1)}µs` : `${perCallUs.toFixed(2)}µs`;
  return { label, value, hint };
}

/** 简易耗时统计：中位数比平均值诚实 —— 平均值会被一次 GC 拉高十倍。 */
export class Timing {
  private readonly samples: number[] = [];

  constructor(private readonly capacity = 60) {}

  push(durationMs: number): void {
    this.samples.push(durationMs);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  get count(): number {
    return this.samples.length;
  }

  get median(): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
  }

  get p95(): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  }

  reset(): void {
    this.samples.length = 0;
  }
}
