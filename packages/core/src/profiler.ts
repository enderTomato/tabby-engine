export interface Stat {
  /** 指数滑动平均，反映「稳态」表现。 */
  readonly avg: number;
  /** 采样窗口内最大值，用于发现瞬时尖刺。 */
  readonly max: number;
  /** 窗口内 p95，抖动评估比平均值更有意义。 */
  readonly p95: number;
  readonly last: number;
}

export interface FrameBudget {
  /** 每帧 CPU 预算（毫秒）。低于此值视为健康。 */
  readonly cpuMs: number;
}

const WINDOW = 120;

/**
 * 帧预算剖析器。
 *
 * 只做定点采样 + 排序求 p95，不引入任何计时器；
 * 移动端上 performance.now() 本身也有开销，故每帧只取 2~3 个采样点。
 */
export class Profiler {
  private readonly frames = new Float64Array(WINDOW);
  private readonly cpu = new Float64Array(WINDOW);
  private readonly scratch = new Float64Array(WINDOW);
  private cursor = 0;
  private filled = 0;
  private lastCpuSampleMs = 0;

  record(frameMs: number, cpuMs: number): void {
    this.frames[this.cursor] = frameMs;
    this.cpu[this.cursor] = cpuMs;
    this.cursor = (this.cursor + 1) % WINDOW;
    this.filled = Math.min(this.filled + 1, WINDOW);
  }

  markCpu(cpuMs: number): void {
    this.lastCpuSampleMs = cpuMs;
  }

  get lastCpuMs(): number {
    return this.lastCpuSampleMs;
  }

  get fps(): number {
    const avg = this.stat(this.frames).avg;
    return avg > 0 ? 1000 / avg : 0;
  }

  get frame(): Stat {
    return this.stat(this.frames);
  }

  get cpuFrame(): Stat {
    return this.stat(this.cpu);
  }

  /** 连续超预算帧数，供自适应降级使用。 */
  overBudgetStreak(budget: FrameBudget): number {
    let streak = 0;
    for (let i = 1; i <= this.filled; i += 1) {
      const idx = (this.cursor - i + WINDOW * 2) % WINDOW;
      if ((this.cpu[idx] ?? 0) > budget.cpuMs) streak += 1;
      else break;
    }
    return streak;
  }

  reset(): void {
    this.frames.fill(0);
    this.cpu.fill(0);
    this.cursor = 0;
    this.filled = 0;
  }

  private stat(source: Float64Array): Stat {
    const n = this.filled;
    if (n === 0) return { avg: 0, max: 0, p95: 0, last: 0 };
    let sum = 0;
    let max = 0;
    for (let i = 0; i < n; i += 1) {
      const v = source[i] ?? 0;
      this.scratch[i] = v;
      sum += v;
      if (v > max) max = v;
    }
    const sorted = this.scratch.subarray(0, n).slice().sort();
    const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0;
    const last = source[(this.cursor - 1 + WINDOW) % WINDOW] ?? 0;
    return { avg: sum / n, max, p95, last };
  }
}
