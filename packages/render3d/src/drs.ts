/**
 * 动态分辨率（DRS）。
 *
 * ## 为什么 Android 上最该优化的是分辨率
 *
 * 手游的性能瓶颈**通常不是三角形数，是填充率**。1080p 的屏幕上一帧要填 200 万像素，
 * 而中低端 GPU 的填充能力就那么点。分辨率降 20%（0.8² = 0.64）就少填 36% 的像素，
 * 帧率往往立刻从 40 拉到 55；而同一台机器上减少一半三角形，可能一帧都省不下来。
 *
 * ## 为什么用中位数 + 迟滞 + 冷却，而不是「超过 16.7ms 就降」
 *
 * 三条都是防抖，缺一条就会看见分辨率在抖：
 *
 * - **中位数**：平均值会被一次 GC 或一次纹理上传拉高十倍，于是刚进场景就误降一档。
 *   中位数看的是「这半秒里大多数帧怎么样」。
 * - **迟滞**：降档阈值 1.15×、升档阈值 0.85×，中间那 30% 是不动区。
 *   单一阈值会让系统在边界上一升一降来回跳。
 * - **冷却**：改分辨率会重建 drawing buffer，本身就要掉几帧。
 *   刚改完立刻重新评估，会读到「自己造成的」掉帧，然后继续降 —— 一路降到底。
 *
 * 这个类不碰 DOM、不碰 three，纯时间序列输入输出，所以能在 Node 里跑测试。
 */

/** 一档采样：一次评估最多看这么多帧的中位数。 */
const WINDOW = 60;

export interface DrsOptions {
  /** 分辨率缩放下限。低于 0.7 时画面已经明显糊，不如降特效。 */
  readonly minScale?: number;
  readonly maxScale?: number;
  /** 目标帧时间（毫秒）。30fps 档传 33.3。 */
  readonly targetFrameMs?: number;
  /** 每次调整的步长。太大能看见「跳一下」，太小追不上负载变化。 */
  readonly step?: number;
  /** 超过目标多少倍就降档。 */
  readonly downRatio?: number;
  /** 低于目标多少倍才升档。留出的空档就是迟滞区。 */
  readonly upRatio?: number;
  /** 两次调整之间至少间隔多久（毫秒）。 */
  readonly cooldownMs?: number;
  /** 两次评估之间的间隔（毫秒）。 */
  readonly evalIntervalMs?: number;
  /** 窗口里至少要有多少帧才评估（避免刚切场景就下结论）。 */
  readonly minSamples?: number;
}

export interface DrsState {
  readonly scale: number;
  /** 最近一次评估用的中位数（毫秒）。0 表示还不够样本。 */
  readonly medianFrameMs: number;
  readonly samples: number;
  /** 累计调整次数（上下都算）。 */
  readonly adjustments: number;
  /** 上次调整的方向：只用于诊断面板。 */
  readonly lastDirection: 'up' | 'down' | 'none';
}

export class DynamicResolution {
  private readonly minScale: number;
  private readonly maxScale: number;
  private readonly targetFrameMs: number;
  private readonly step: number;
  private readonly downRatio: number;
  private readonly upRatio: number;
  private readonly cooldownMs: number;
  private readonly evalIntervalMs: number;
  private readonly minSamples: number;

  private current: number;
  /** 环形缓冲：固定 60 格，不随运行时长增长。 */
  private readonly frames = new Float32Array(WINDOW);
  private write = 0;
  private filled = 0;
  private lastEval = -Infinity;
  private lastChange = -Infinity;
  private adjustments = 0;
  private lastDirection: 'up' | 'down' | 'none' = 'none';
  private median = 0;

  constructor(options: DrsOptions = {}) {
    this.minScale = options.minScale ?? 0.7;
    this.maxScale = options.maxScale ?? 1;
    this.targetFrameMs = options.targetFrameMs ?? 1000 / 60;
    this.step = options.step ?? 0.05;
    this.downRatio = options.downRatio ?? 1.15;
    this.upRatio = options.upRatio ?? 0.85;
    this.cooldownMs = options.cooldownMs ?? 1500;
    this.evalIntervalMs = options.evalIntervalMs ?? 500;
    this.minSamples = options.minSamples ?? 30;
    this.current = this.maxScale;
  }

  get scale(): number {
    return this.current;
  }

  get state(): DrsState {
    return {
      scale: this.current,
      medianFrameMs: this.median,
      samples: this.filled,
      adjustments: this.adjustments,
      lastDirection: this.lastDirection,
    };
  }

  /**
   * 喂一帧。
   *
   * `frameMs` 是上一帧的耗时，`nowMs` 是当前时刻（同一时钟）。
   * 返回 true 表示**这一帧之后分辨率变了**，调用方据此重建 drawing buffer。
   */
  push(frameMs: number, nowMs: number): boolean {
    // NaN / 负数 / 离谱的大值都丢掉：切后台回来的第一帧可能是几秒
    if (!(frameMs > 0) || frameMs > 1000) return false;

    this.frames[this.write] = frameMs;
    this.write = (this.write + 1) % WINDOW;
    if (this.filled < WINDOW) this.filled += 1;

    if (this.filled < this.minSamples) return false;
    if (nowMs - this.lastEval < this.evalIntervalMs) return false;
    this.lastEval = nowMs;

    this.median = median(this.frames, this.filled);

    // 冷却期内只更新中位数，不改分辨率
    if (nowMs - this.lastChange < this.cooldownMs) return false;

    const tooSlow = this.median > this.targetFrameMs * this.downRatio;
    const plenty = this.median < this.targetFrameMs * this.upRatio;

    if (tooSlow && this.current > this.minScale) {
      this.current = round2(Math.max(this.minScale, this.current - this.step));
      this.markChange(nowMs, 'down');
      return true;
    }
    if (plenty && this.current < this.maxScale) {
      this.current = round2(Math.min(this.maxScale, this.current + this.step));
      this.markChange(nowMs, 'up');
      return true;
    }
    return false;
  }

  /** 切场景 / 切前后台时调用：丢掉旧样本，避免用上一个场景的负载做判断。 */
  reset(scale?: number): void {
    this.write = 0;
    this.filled = 0;
    this.median = 0;
    this.lastEval = -Infinity;
    this.lastChange = -Infinity;
    if (scale !== undefined) this.current = clamp(scale, this.minScale, this.maxScale);
  }

  private markChange(nowMs: number, direction: 'up' | 'down'): void {
    this.lastChange = nowMs;
    this.adjustments += 1;
    this.lastDirection = direction;
  }
}

/** 取窗口内的中位数。排序会分配，但每秒只调两次，代价可以忽略。 */
function median(buffer: Float32Array, count: number): number {
  const slice = Array.from(buffer.subarray(0, count));
  slice.sort((a, b) => a - b);
  const mid = count >> 1;
  return count % 2 === 0 ? ((slice[mid - 1] as number) + (slice[mid] as number)) / 2 : (slice[mid] as number);
}

/** 缩放到两位小数：0.7 + 0.05 累加会出现 0.7499999999999999，写进 padding 就是脏数字。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
