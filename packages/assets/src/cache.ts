/**
 * 资源缓存 —— 引用计数 + 延迟释放 + 并发合并 + 失败缓存。
 *
 * ## 为什么不是简单的 Map + LRU
 *
 * 一个纹理被 40 栋楼共用。若用「最近最少使用」淘汰，玩家视角转一下、
 * 有 5 栋楼被别的楼挡住剔除，计数器掉到 35，纹理却被淘汰了 ——
 * 再转回来就要重新下载、重新上传显存，画面卡一下。
 * 所以先做**引用计数**：只有 NOBODY 在用了才谈淘汰。
 *
 * ## 为什么 release 之后不立刻 dispose
 *
 * 引用计数归零最常见的场景不是「这资源没用了」，而是**一帧之内的抖动**：
 * 建筑被重建（拆了再放）、关卡切换的两帧之间、UI 面板收起又打开。
 * 立刻 dispose 就会在同一帧里释放再加载。
 * 所以归零先进待淘汰队列，过了 `graceMs` 才真释放 —— 这段时间内再 acquire
 * 是免费的（`revived` 计数能看出这条优化有没有生效）。
 *
 * ## 为什么失败也要缓存
 *
 * 弱网下 404 或超时的 URL 会被反复重试：每栋楼加载时各试一遍，
 * 40 栋楼就是 40 次注定失败的请求 —— 比不加载还慢。
 * 所以失败记一笔，`failureTtlMs` 内直接 reject，不再发请求。
 * TTL 到期后允许重试：网络恢复时不该永久躺平。
 *
 * ## 为什么同一 key 的并发请求要合并
 *
 * 首帧的城市里 40 栋楼同时 acquire 同一个纹理，浏览器会发 40 个请求。
 * in-flight 表让它们共享一个 Promise —— 这一条在移动端是数量级的差别。
 */

export interface AssetCacheOptions<T> {
  /** 真正的加载逻辑。同一个 key 在合并窗口内只会被调用一次。 */
  readonly loader: (key: string) => Promise<T>;
  /** 真正释放资源（`texture.dispose()` / `geometry.dispose()` 之类）。 */
  readonly dispose: (value: T) => void;
  /** 取时间，默认 `performance.now`。测试注入假时钟。 */
  readonly clock?: () => number;
  /** 引用归零后多久才真释放（毫秒）。默认 5000。 */
  readonly graceMs?: number;
  /** 条目上限（含待淘汰）。超了立刻按最久未用淘汰。默认 64。 */
  readonly maxEntries?: number;
  /** 失败缓存的存活时间（毫秒）。默认 10000。 */
  readonly failureTtlMs?: number;
}

export interface AssetCacheStats {
  /** 当前有引用的条目数。 */
  readonly live: number;
  /** 引用归零、等待回收的条目数。 */
  readonly pending: number;
  /** 命中（已有引用，直接返回）。 */
  readonly hits: number;
  /** 未命中（要真加载）。 */
  readonly misses: number;
  /** 待淘汰期间被重新 acquire 救回来的次数。 */
  readonly revived: number;
  /** 真正 dispose 掉的次数。 */
  readonly evictions: number;
  /** 因容量上限被强制淘汰的次数。 */
  readonly forced: number;
  /** 被并发合并掉的请求数。 */
  readonly coalesced: number;
  /** 命中失败缓存、没有发请求的次数。 */
  readonly shortCircuits: number;
  /** 真发起过的加载次数。 */
  readonly loads: number;
}

interface Entry<T> {
  readonly key: string;
  value: T;
  refs: number;
  lastUsed: number;
  /** 非 null 表示引用已归零，从这个时刻起算宽限期。 */
  pendingSince: number | null;
}

const DEFAULT_GRACE_MS = 5000;
const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_FAILURE_TTL_MS = 10000;

export class AssetCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  /** key → 失败缓存到期时刻。 */
  private readonly failures = new Map<string, number>();
  private readonly options: AssetCacheOptions<T>;
  private readonly clock: () => number;
  private readonly graceMs: number;
  private readonly maxEntries: number;
  private readonly failureTtlMs: number;
  private counters = {
    hits: 0,
    misses: 0,
    revived: 0,
    evictions: 0,
    forced: 0,
    coalesced: 0,
    shortCircuits: 0,
    loads: 0,
  };

  constructor(options: AssetCacheOptions<T>) {
    this.options = options;
    this.clock = options.clock ?? (() => performance.now());
    this.graceMs = Math.max(0, options.graceMs ?? DEFAULT_GRACE_MS);
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.failureTtlMs = Math.max(0, options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS);
  }

  get stats(): AssetCacheStats {
    let live = 0;
    let pending = 0;
    for (const entry of this.entries.values()) {
      if (entry.pendingSince === null) live += 1;
      else pending += 1;
    }
    return { live, pending, ...this.counters };
  }

  /**
   * 取用资源，引用计数 +1。
   *
   * 已存在（含待淘汰）直接复用；正在加载则共享同一个 Promise；
   * 失败缓存在有效期内直接 reject。
   *
   * `loader` 可逐次覆盖：同一个缓存实例既装纹理又装网格时，
   * 两类资源需要不同的加载逻辑，但引用计数与淘汰策略是通用的。
   */
  acquire(key: string, loader?: (key: string) => Promise<T>): Promise<T> {
    const now = this.clock();
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      const revived = existing.pendingSince !== null;
      existing.refs += 1;
      existing.lastUsed = now;
      existing.pendingSince = null;
      if (revived) this.counters.revived += 1;
      else this.counters.hits += 1;
      return Promise.resolve(existing.value);
    }

    const running = this.inflight.get(key);
    if (running !== undefined) {
      // 合并：引用计数在 resolve 后补，否则加载失败会漏减
      this.counters.coalesced += 1;
      return running.then((value) => {
        this.retainResolved(key, value);
        return value;
      });
    }

    const failedUntil = this.failures.get(key);
    if (failedUntil !== undefined && now < failedUntil) {
      this.counters.shortCircuits += 1;
      return Promise.reject(new Error(`资源 ${key} 刚刚加载失败，${Math.ceil(failedUntil - now)}ms 内不再重试`));
    }

    this.counters.misses += 1;
    this.counters.loads += 1;
    const task = (loader ?? this.options.loader)(key).then(
      (value) => {
        this.inflight.delete(key);
        this.failures.delete(key);
        this.entries.set(key, { key, value, refs: 1, lastUsed: this.clock(), pendingSince: null });
        this.enforceCapacity();
        return value;
      },
      (error: unknown) => {
        this.inflight.delete(key);
        this.failures.set(key, this.clock() + this.failureTtlMs);
        throw error;
      },
    );
    this.inflight.set(key, task);
    return task;
  }

  /**
   * 释放一次引用。计数归零时进入待淘汰队列，返回是否归零。
   *
   * 不认识的 key 或已经归零还再释放，返回 `false` ——
   * 这说明调用方的 acquire/release 不配对，值得在诊断里看到。
   */
  release(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    if (entry.refs <= 0) return false;
    entry.refs -= 1;
    if (entry.refs > 0) return false;
    entry.pendingSince = this.clock();
    entry.lastUsed = this.clock();
    return true;
  }

  /** 只看一眼，不影响引用计数。给诊断面板用。 */
  peek(key: string): T | null {
    return this.entries.get(key)?.value ?? null;
  }

  /** 某个 key 当前的引用数。 */
  refsOf(key: string): number {
    return this.entries.get(key)?.refs ?? 0;
  }

  /**
   * 回收已过宽限期的条目，返回回收数量。
   *
   * 每帧调也没问题（它就是一次遍历），但更省的做法是 1Hz 调一次。
   * 遍历 `Map` 的同时删除是安全的（JS 保证不会重复访问）。
   */
  collect(): number {
    const now = this.clock();
    let collected = 0;
    for (const [key, entry] of this.entries) {
      if (entry.pendingSince === null) continue;
      if (now - entry.pendingSince < this.graceMs) continue;
      this.disposeEntry(key, entry);
      collected += 1;
    }
    return collected;
  }

  /** 立刻释放所有能释放的（场景切换、视图销毁时用）。仍在引用的不碰。 */
  releaseAll(): number {
    let released = 0;
    for (const entry of this.entries.values()) {
      if (entry.pendingSince === null) {
        entry.refs = 0;
        entry.pendingSince = this.clock();
        released += 1;
      }
    }
    return released;
  }

  /** 无视引用计数全部销毁（引擎 shutdown）。 */
  clear(): void {
    for (const [key, entry] of this.entries) this.disposeEntry(key, entry);
    this.entries.clear();
    this.inflight.clear();
    this.failures.clear();
  }

  private retainResolved(key: string, value: T): void {
    const entry = this.entries.get(key);
    if (entry !== undefined && entry.value === value) {
      entry.refs += 1;
      entry.lastUsed = this.clock();
      entry.pendingSince = null;
      return;
    }
    this.entries.set(key, { key, value, refs: 1, lastUsed: this.clock(), pendingSince: null });
    this.enforceCapacity();
  }

  /** 超过上限时按「最久未用」强制淘汰待淘汰项；还在引用的不动。 */
  private enforceCapacity(): void {
    if (this.entries.size <= this.maxEntries) return;
    // 只在待淘汰里挑：有引用的资源被强行释放，引用方下次拿到的是已销毁对象
    const victims: Entry<T>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.pendingSince !== null) victims.push(entry);
    }
    victims.sort((a, b) => a.lastUsed - b.lastUsed);
    let overflow = this.entries.size - this.maxEntries;
    for (const victim of victims) {
      if (overflow <= 0) break;
      this.disposeEntry(victim.key, victim);
      this.counters.forced += 1;
      overflow -= 1;
    }
  }

  private disposeEntry(key: string, entry: Entry<T>): void {
    try {
      this.options.dispose(entry.value);
    } catch {
      // 释放失败不该把调用方拖下水：资源可能已经被 Three 自己回收了
    }
    this.entries.delete(key);
    this.counters.evictions += 1;
  }
}
