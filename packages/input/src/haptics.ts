/**
 * 触感反馈（震动）能力探测与节流。
 *
 * ## 为什么这不是一行 `navigator.vibrate(10)`
 *
 * 这个 API 的坑比它的功能多：
 *
 * 1. **iOS Safari 完全不支持**（iPhone 上没有 Web 触感反馈，只能用音频 hack 或原生壳）。
 * 2. **安卓 Chrome 要求用户手势**：在非用户手势的调用栈里调用会静默失败并返回 false。
 * 3. **必须先 `sticky activation`**：页面加载完立刻震一下是无效的。
 * 4. **无限制连续调用会抛错**：Chrome 对 1 秒内的高频调用有节流，超出直接忽略。
 * 5. **省电模式 / 静音模式下可能被系统吞掉**，`vibrate()` 依然返回 true。
 *
 * 所以这里做三件事：探测、节流、丢弃而不是抛错。
 *
 * ## 为什么返回布尔值而不是 void
 *
 * 调用方经常需要「震了才播呼吸动画」这类联动。返回 false 表示「这次没震成」，
 * 让上层可以退回到纯视觉反馈，而不是让玩家觉得「点了没反应」。
 */

/** 最短间隔：低于它就不震。60ms 是「连续点击」与「独立两次操作」的分界。 */
export const VIBRATE_MIN_INTERVAL_MS = 60;

export interface HapticsOptions {
  /** 关闭触感（设置项）。默认开启。 */
  readonly enabled?: boolean;
  /** 最小间隔（毫秒）。 */
  readonly minIntervalMs?: number;
  /** 注入时钟，测试用。 */
  readonly now?: () => number;
}

export interface HapticsReport {
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly attempts: number;
  readonly accepted: number;
  readonly throttled: number;
  readonly failed: number;
}

type VibrateFn = (pattern: number | number[]) => boolean;

export class Haptics {
  private supported = false;
  private enabled: boolean;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private lastAt = Number.NEGATIVE_INFINITY;
  private attempts = 0;
  private accepted = 0;
  private throttled = 0;
  private failed = 0;

  constructor(options: HapticsOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? VIBRATE_MIN_INTERVAL_MS);
    this.now = options.now ?? (() => Date.now());
    this.supported = detectVibrate();
  }

  get isSupported(): boolean {
    return this.supported;
  }

  /** 开关。关掉之后再调用 `vibrate` 一律返回 false，且不计入统计。 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled && this.supported;
  }

  /** 短震。返回是否真的下发了震动。 */
  vibrate(durationMs = 12): boolean {
    return this.pulse(durationMs);
  }

  /**
   * 带节奏的震动。`[震, 停, 震, 停, …]`，单位毫秒。
   *
   * 用长按/错误提示这类场景。注意安卓上单次 pattern 总时长超过 10 秒会被忽略。
   */
  pattern(steps: readonly number[]): boolean {
    if (steps.length === 0) return false;
    return this.pulse([...steps]);
  }

  /** 选择框式的「轻触确认」，两种力度。 */
  tick(): boolean {
    return this.pulse(8);
  }

  impact(): boolean {
    return this.pulse(16);
  }

  report(): HapticsReport {
    return {
      supported: this.supported,
      enabled: this.enabled,
      attempts: this.attempts,
      accepted: this.accepted,
      throttled: this.throttled,
      failed: this.failed,
    };
  }

  private pulse(value: number | number[]): boolean {
    if (!this.enabled || !this.supported) return false;
    this.attempts += 1;

    const now = this.now();
    if (now - this.lastAt < this.minIntervalMs) {
      this.throttled += 1;
      return false;
    }
    this.lastAt = now;

    const fn = (navigator as unknown as { vibrate?: VibrateFn }).vibrate;
    if (typeof fn !== 'function') {
      // 运行中掉能力（某些 WebView 会在后台撤销）——标记为不支持，后续不再尝试
      this.supported = false;
      this.failed += 1;
      return false;
    }
    try {
      // 注意 `this` 必须绑回 navigator：直接 `const f = navigator.vibrate; f()` 在
      // 旧 Chrome 上会抛 Illegal invocation
      const ok = fn.call(navigator, value);
      if (ok) this.accepted += 1;
      else this.failed += 1;
      return ok;
    } catch {
      this.failed += 1;
      return false;
    }
  }
}

/**
 * 探测 vibrate 是否可用。
 *
 * 只探测「函数存在」，不探测「真的会震」—— 后者只有在用户手势里调用才知道，
 * 而把探测做成「加载时先震一下」会骚扰用户，还会因为无用户手势而必然失败。
 */
function detectVibrate(): boolean {
  if (typeof navigator === 'undefined') return false;
  const fn = (navigator as unknown as { vibrate?: unknown }).vibrate;
  return typeof fn === 'function';
}
