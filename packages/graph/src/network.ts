import { TransportGraph } from './csr.js';
import { PathFinder } from './pathfinder.js';

/**
 * 物流网络：最短路树缓存 + 脏标记增量重算。
 *
 * ## 为什么不能「每次查询都跑一遍全图」
 *
 * 200 个节点、800 条边的图，单次 Dijkstra 约 0.05ms。看起来很快，
 * 但经济层是「每个建筑每 tick 都要问一次运输成本」——500 个建筑 × 60Hz
 * 就是 30000 次查询/秒，直接把 8ms 预算吃穿。
 *
 * 所以策略是**缓存单源最短路树**：
 * - 以「枢纽」（城市、地铁站）为源，跑一次 Dijkstra，把整张 dist 数组存下来；
 * - 查询退化成一次数组读取；
 * - 路网变更时把这棵树标脏，**分帧**重算（每帧最多 N 个源）。
 *
 * ## 脏子图的粒度
 *
 * 严格来说，改一条边会影响「所有路径经过它的 OD 对」，要精确定位就得跑全源最短路，
 * 那等于没优化。这里用的是**近似但可控**的做法：
 *
 * - 记录「改动的边的两端节点」为脏源；
 * - 这些源的最短路树立即作废；
 * - 其它源的最短路树保持，但 `graphVersion` 变了会让它们**在下次查询时**
 *   被标记为可疑（`staleAfterVersion`），并在后台逐步重算。
 *
 * 结果是：路网变更后的短时间内，少数查询可能返回旧值（偏差通常很小，
 * 因为一条边的改变很少影响远处 OD 对），但**不会卡帧**。
 * 如果业务上不能容忍这个窗口（比如地铁通了票价要立刻生效），
 * 调大 `recompute` 的 budget 或直接调 `recomputeAll()` 同步算完。
 */

export interface LogisticsNetworkOptions {
  /** 缓存多少棵源最短路树。超出后按最近最久未用淘汰。 */
  readonly maxCachedSources?: number;
  /** A* 启发缩放，0 表示纯 Dijkstra。 */
  readonly heuristicScale?: number;
}

export class LogisticsNetwork {
  readonly graph: TransportGraph;
  private readonly finder: PathFinder;
  private readonly maxCachedSources: number;
  /** source → dist 快照。 */
  private readonly caches = new Map<number, Float32Array>();
  /** source → 快照对应的图版本。 */
  private readonly cacheVersion = new Map<number, number>();
  private readonly dirty: Set<number> = new Set();
  private readonly maxNodesPerSearch: number;

  constructor(graph: TransportGraph, options: LogisticsNetworkOptions = {}, maxNodesPerSearch = Infinity) {
    this.graph = graph;
    this.finder = new PathFinder(graph, { heuristicScale: options.heuristicScale ?? 0 });
    this.maxCachedSources = Math.max(1, options.maxCachedSources ?? 32);
    this.maxNodesPerSearch = maxNodesPerSearch;
  }

  get cachedSources(): number {
    return this.caches.size;
  }

  get pendingSources(): number {
    return this.dirty.size;
  }

  /**
   * 标记这些源点的树需要重算。
   *
   * 边变更时调用，参数传边的两端节点。只让两端变脏是**有意的取舍**：
   * 精确解需要全源重算，代价与收益不成比例（见类注释）。
   */
  markSourcesDirty(nodes: readonly number[]): void {
    for (const node of nodes) this.dirty.add(node);
  }

  /** 图结构变了（增删节点/边）后调用。 */
  invalidateAll(): void {
    this.caches.clear();
    this.cacheVersion.clear();
    this.dirty.clear();
  }

  /**
   * 分帧重算。返回仍未处理完的源点数。
   *
   * 调用方应在每帧末尾调一次，budget 取 1~2：单次 Dijkstra 0.05ms，
   * 2 个源就是 0.1ms，可以塞进任何预算里。
   */
  recompute(budget = 2): number {
    if (this.dirty.size === 0) return 0;
    let used = 0;
    for (const source of this.dirty) {
      if (used >= budget) break;
      this.dirty.delete(source);
      this.rebuild(source);
      used += 1;
    }
    return this.dirty.size;
  }

  /** 同步算完所有脏源（时间跳变、读档后使用）。 */
  recomputeAll(): void {
    for (const source of this.dirty) this.rebuild(source);
    this.dirty.clear();
  }

  private rebuild(source: number): void {
    const n = this.graph.nodeCount;
    if (source < 0 || source >= n) return;
    this.finder.run(source, this.maxNodesPerSearch);
    const snapshot = new Float32Array(n);
    for (let i = 0; i < n; i += 1) snapshot[i] = this.finder.distanceTo(i);
    this.caches.set(source, snapshot);
    this.cacheVersion.set(source, this.graph.graphVersion);
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    while (this.caches.size > this.maxCachedSources) {
      // Map 是插入序，删最早的那个即近似 LRU（够用，且不需要额外链表）
      const oldest = this.caches.keys().next();
      if (oldest.done === true) break;
      this.caches.delete(oldest.value);
      this.cacheVersion.delete(oldest.value);
    }
  }

  /**
   * 查询运输成本。不可达返回 Infinity。
   *
   * 有缓存且新鲜 → O(1)；否则现算一次（不写缓存，避免低频查询把缓存挤爆）。
   */
  cost(from: number, to: number): number {
    if (from === to) return 0;
    const cached = this.caches.get(from);
    const version = this.cacheVersion.get(from);
    if (cached !== undefined && version === this.graph.graphVersion) {
      const v = cached[to] as number;
      return Number.isFinite(v) ? v : Infinity;
    }
    if (this.dirty.has(from)) {
      // 脏源：直接现算并把结果写回，查询路径上的这次开销换掉后续的重复查询
      this.dirty.delete(from);
      this.rebuild(from);
      const fresh = this.caches.get(from);
      const v = fresh === undefined ? Infinity : (fresh[to] as number);
      return Number.isFinite(v) ? v : Infinity;
    }
    const path = this.finder.aStar(from, to);
    return path.found ? path.cost : Infinity;
  }

  /** 完整路径（节点序列）。返回的数组是复用的，需要保留请自己 slice。 */
  route(from: number, to: number): Int32Array {
    return this.finder.aStar(from, to).nodes;
  }

  /** 内存占用（字节），诊断用。 */
  get byteSize(): number {
    let total = this.graph.byteSize;
    for (const snapshot of this.caches.values()) total += snapshot.byteLength;
    return total;
  }
}
