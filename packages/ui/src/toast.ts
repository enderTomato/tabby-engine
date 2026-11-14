/**
 * Toast 队列 —— 游戏内短提示。
 *
 * ## 为什么是队列而不是一个字符串
 *
 * 一个 `ref<string>` 的问题是「后一条覆盖前一条」：玩家连点建造，
 * 提示全被冲掉，等于没有提示。排队之后每条至少显示 `ttlMs`，
 * 但队列长度必须封顶 —— 否则连点 30 次要看 30 条，比覆盖更糟。
 *
 * ## 为什么同一句话不重复入队
 *
 * 连点同一个按钮是最高频的操作，但它产生的提示是同一条信息。
 * 这里对「和队尾文本相同」的情况只刷新计时，不新增一条 ——
 * 结果就是屏幕上那条提示的存活时间被续上了，读起来像「还在发生」。
 *
 * ## 为什么 prune 返回布尔
 *
 * 这个类不持有任何响应式状态。调用方每 10Hz 调一次 `prune()`，
 * 返回 `true` 才去写 Vue 的 ref —— 没有变化就不触发渲染。
 */

export interface ToastQueueOptions {
  /** 每条提示的存活时间（毫秒），默认 2600。 */
  readonly ttlMs?: number;
  /** 队列上限，超出丢弃最旧的，默认 4。 */
  readonly max?: number;
  /** 取当前时间的函数，默认 `performance.now`。测试里可注入假时钟。 */
  readonly now?: () => number;
}

interface Entry {
  readonly text: string;
  bornAt: number;
}

const DEFAULT_TTL = 2600;
const DEFAULT_MAX = 4;

export class ToastQueue {
  private readonly entries: Entry[] = [];
  private readonly ttl: number;
  private readonly max: number;
  private readonly clock: () => number;

  constructor(options: ToastQueueOptions = {}) {
    this.ttl = options.ttlMs ?? DEFAULT_TTL;
    this.max = Math.max(1, options.max ?? DEFAULT_MAX);
    this.clock = options.now ?? (() => performance.now());
  }

  get size(): number {
    return this.entries.length;
  }

  /** 入队一条提示。与队尾文本相同时只续命，不新增。 */
  push(text: string): void {
    if (text.length === 0) return;
    const now = this.clock();
    const tail = this.entries[this.entries.length - 1];
    if (tail !== undefined && tail.text === text) {
      tail.bornAt = now;
      return;
    }
    this.entries.push({ text, bornAt: now });
    while (this.entries.length > this.max) this.entries.shift();
  }

  /** 当前该显示的文字（先丢弃过期的）。 */
  peek(): string | null {
    this.prune();
    return this.entries[0]?.text ?? null;
  }

  /**
   * 丢弃过期项，返回是否发生了变化。
   *
   * 只在队首过期时才真正移除：后面的项在排队，还没轮到它开始计时。
   * 这与「每条独立倒计时」不同 —— 独立倒计时会导致队列快速清空，
   * 玩家根本来不及读后面几条。
   */
  prune(): boolean {
    const now = this.clock();
    const head = this.entries[0];
    if (head === undefined) return false;
    if (now - head.bornAt < this.ttl) return false;
    this.entries.shift();
    // 队首过期后，下一条从现在开始计时 —— 而不是拿它的 bornAt 去判断，
    // 否则排队期间它就一直在"过期"，一 shift 又是过期，整个队列瞬间清空。
    const next = this.entries[0];
    if (next !== undefined) next.bornAt = now;
    return true;
  }

  /** 队首剩余显示时间（毫秒），UI 可用来做淡出。无内容时返回 0。 */
  remaining(): number {
    const head = this.entries[0];
    if (head === undefined) return 0;
    return Math.max(0, this.ttl - (this.clock() - head.bornAt));
  }

  clear(): void {
    this.entries.length = 0;
  }
}
