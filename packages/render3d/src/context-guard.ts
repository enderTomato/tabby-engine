/**
 * WebGL 上下文丢失与恢复。
 *
 * ## 为什么这个在 Android 上是**稳定性**问题，不是优化项
 *
 * 手机上切后台、来电、锁屏、系统内存吃紧，驱动都可能直接把 GL 上下文收走。
 * 桌面浏览器里几乎见不到（除了 GPU 崩溃），所以很容易漏做。漏了的表现是：
 * 用户切回游戏，看到一片黑 —— 而且**再也不会恢复**，因为浏览器默认
 * 不会去救一个没有 `preventDefault()` 的丢失事件。
 *
 * 两个必做的动作：
 *
 * 1. `webglcontextlost` 里 **`event.preventDefault()`**：这是告诉浏览器
 *    「我想恢复」。不调它，`webglcontextrestored` 永远不会来。
 * 2. 恢复后**重建 GPU 侧资源并让主循环重新跑起来**。three 会自己丢弃
 *    内部属性表、按需重传，但业务侧的状态（我们在跑的模拟）需要外部显式重启，
 *    否则会出现「画面回来了但世界不动了」。
 *
 * ## 为什么恢复要延迟一帧
 *
 * `webglcontextrestored` 触发时，驱动可能还没完全就绪。立刻创建纹理/缓冲，
 * 有概率拿到 INVALID_OPERATION，然后就永远缺一块。等一帧再重建，
 * 实测（Chrome on Android）稳定得多。
 */

export interface ContextGuardOptions {
  /** 上下文丢失时调用。这里通常要停掉模拟、暂停音频、置黑屏遮罩。 */
  readonly onLost?: () => void;
  /** 上下文恢复且延迟结束后调用。这里要重建资源、重置 DRS 样本、恢复主循环。 */
  readonly onRestored?: () => void;
  /** 恢复后等多久再重建（毫秒）。默认 1 帧。 */
  readonly restoreDelayMs?: number;
  /** 延迟实现。浏览器传 `setTimeout`；测试里可以换成同步实现。 */
  readonly schedule?: (task: () => void, delayMs: number) => void;
}

export class ContextGuard {
  private target: EventTarget | null = null;
  private readonly options: ContextGuardOptions;
  private lost = false;
  private lostCount = 0;
  private restoredCount = 0;
  private disposed = false;

  constructor(target: EventTarget, options: ContextGuardOptions = {}) {
    this.target = target;
    this.options = options;
    target.addEventListener('webglcontextlost', this.onLost, false);
    target.addEventListener('webglcontextrestored', this.onRestored, false);
  }

  get isLost(): boolean {
    return this.lost;
  }

  /** 丢失次数。诊断面板上这个数大于 0 就说明这台机器遇到过驱动回收。 */
  get stats(): { readonly lost: number; readonly restored: number; readonly currentlyLost: boolean } {
    return { lost: this.lostCount, restored: this.restoredCount, currentlyLost: this.lost };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target?.removeEventListener('webglcontextlost', this.onLost, false);
    this.target?.removeEventListener('webglcontextrestored', this.onRestored, false);
    this.target = null;
  }

  private readonly onLost = (event: Event): void => {
    // 不 preventDefault 就没有 restored 事件 —— 这一行是整个文件存在的理由
    event.preventDefault();
    if (this.lost) return;
    this.lost = true;
    this.lostCount += 1;
    this.options.onLost?.();
  };

  private readonly onRestored = (event: Event): void => {
    void event;
    if (!this.lost) return;
    const commit = (): void => {
      if (this.disposed) return;
      this.lost = false;
      this.restoredCount += 1;
      this.options.onRestored?.();
    };
    const delay = this.options.restoreDelayMs ?? 16;
    const schedule = this.options.schedule ?? ((task, ms) => setTimeout(task, ms));
    schedule(commit, delay);
  };
}
