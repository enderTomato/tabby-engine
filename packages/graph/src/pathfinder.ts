import type { TransportGraph } from './csr.js';

/**
 * 最短路：二叉堆 Dijkstra + 可选 A*。
 *
 * ## 三个实现要点
 *
 * **1. 堆用「惰性删除」而不是 decrease-key。**
 * 标准 Dijkstra 需要在松弛时降低堆里已有节点的 key，那就要位置索引表。
 * 惰性删除的写法是：每次松弛成功就 push 一个新条目，弹出时检查该节点是否已定局，
 * 是则跳过。堆的条目数上限变成边数，但代码简单一半，且没有索引表要维护。
 * 实测 200 节点图上差异小于 0.01ms。
 *
 * **2. 距离表用「版本戳」清空，不做 fill。**
 * 每次查询 fill 一遍 Float32Array 是 O(n)，在「每帧查几十条路径」时累积可观。
 * 改用 `stamp[i] === currentStamp` 判断是否初始化过，O(1) 清空。
 *
 * **3. 等权路径的 tie-break 必须确定。**
 * 堆比较时 key 相同则节点索引小的优先。节点索引由插入顺序决定 ——
 * 而插入顺序取决于玩家建造顺序，所以这里的确定性只是「同一次运行内稳定」。
 * 真正跨存档的确定性由 `LogisticsNetwork` 保证：节点按 id 排序后建图。
 * 这一点在 ADR-009 里写明了，不要以为堆里排了序就万事大吉。
 */

/** 二叉最小堆。key 相同按 node 升序，保证确定性。 */
export class BinaryHeap {
  private nodes: Int32Array;
  private keys: Float32Array;
  private size = 0;

  constructor(capacity = 256) {
    const c = Math.max(8, capacity);
    this.nodes = new Int32Array(c);
    this.keys = new Float32Array(c);
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.size = 0;
  }

  push(node: number, key: number): void {
    if (this.size >= this.nodes.length) this.grow();
    let i = this.size;
    this.size += 1;
    this.nodes[i] = node;
    this.keys[i] = key;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** 弹出最小节点的索引，空堆返回 -1。 */
  pop(): number {
    if (this.size === 0) return -1;
    const top = this.nodes[0] as number;
    this.size -= 1;
    if (this.size > 0) {
      this.nodes[0] = this.nodes[this.size] as number;
      this.keys[0] = this.keys[this.size] as number;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= this.size) break;
        const r = l + 1;
        let best = l;
        if (r < this.size && this.less(r, l)) best = r;
        if (!this.less(best, i)) break;
        this.swap(i, best);
        i = best;
      }
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    const ka = this.keys[a] as number;
    const kb = this.keys[b] as number;
    if (ka !== kb) return ka < kb;
    // 等权时按节点索引，避免同一张图两次查询得到不同路径
    return (this.nodes[a] as number) < (this.nodes[b] as number);
  }

  private swap(a: number, b: number): void {
    const n = this.nodes[a] as number;
    this.nodes[a] = this.nodes[b] as number;
    this.nodes[b] = n;
    const k = this.keys[a] as number;
    this.keys[a] = this.keys[b] as number;
    this.keys[b] = k;
  }

  private grow(): void {
    const next = this.nodes.length * 2;
    const nodes = new Int32Array(next);
    nodes.set(this.nodes);
    const keys = new Float32Array(next);
    keys.set(this.keys);
    this.nodes = nodes;
    this.keys = keys;
  }
}

export interface PathResult {
  readonly found: boolean;
  readonly cost: number;
  /** 节点序列（含起点与终点）。用 Int32Array 避免每次查询分配数组。 */
  readonly nodes: Int32Array;
  readonly hops: number;
}

const EMPTY_PATH = new Int32Array(0);

export interface PathFinderOptions {
  /**
   * A* 启发函数的缩放系数。0 表示退化为 Dijkstra（默认）。
   *
   * 只有确认「边成本 ≥ 欧氏距离 × scale」时才可以把 scale 设为非 0，
   * 否则启发式会高估、A* 返回的就不再是最短路。
   * 默认 0 是刻意的：正确性优先，A* 作为可选加速。
   */
  readonly heuristicScale?: number;
}

export class PathFinder {
  readonly graph: TransportGraph;
  private readonly dist: Float32Array;
  private readonly prev: Int32Array;
  private readonly stamp: Int32Array;
  private readonly closed: Uint8Array;
  private readonly heap: BinaryHeap;
  private currentStamp = 0;
  private readonly heuristicScale: number;
  /** 路径重建用的复用缓冲。 */
  private readonly pathBuffer: Int32Array;
  private lastSource = -1;
  private lastSettled = 0;

  constructor(graph: TransportGraph, options: PathFinderOptions = {}) {
    this.graph = graph;
    this.heuristicScale = Math.max(0, options.heuristicScale ?? 0);
    const n = Math.max(1, graph.nodeCount);
    this.dist = new Float32Array(n);
    this.prev = new Int32Array(n);
    this.stamp = new Int32Array(n);
    this.closed = new Uint8Array(n);
    this.pathBuffer = new Int32Array(n);
    this.heap = new BinaryHeap(Math.max(64, n));
  }

  /** 上一次单源查询里被定局的节点数，用于「重算成本」统计。 */
  get settledNodes(): number {
    return this.lastSettled;
  }

  /**
   * 单源最短路。结果通过 `distanceTo` / `pathTo` 读取。
   *
   * `maxNodes` 可以限制扩散规模（低端机降级用）：达到上限就提前停止，
   * 此时远端节点的距离是「上界」而不是精确值。上层需要知道这一点，
   * 所以返回值给出是否完整结束。
   */
  run(source: number, maxNodes = Infinity): boolean {
    const graph = this.graph;
    graph.ensureBuilt();
    const n = graph.nodeCount;
    if (source < 0 || source >= n) return false;

    this.lastSource = source;
    this.lastSettled = 0;
    this.currentStamp += 1;
    const s = this.currentStamp;
    const heap = this.heap;
    heap.clear();

    this.stamp[source] = s;
    this.dist[source] = 0;
    this.prev[source] = -1;
    this.closed[source] = 0;
    heap.push(source, 0);

    let settled = 0;
    while (heap.length > 0) {
      const node = heap.pop();
      if (node < 0) break;
      if (this.stamp[node] !== s) continue;
      if (this.closed[node] === 1) continue;
      this.closed[node] = 1;
      settled += 1;
      if (settled >= maxNodes) {
        this.lastSettled = settled;
        return false;
      }

      const dn = this.dist[node] as number;
      const range = graph.edgeRange(node);
      for (let e = range[0]; e < range[1]; e += 1) {
        const next = graph.target(e);
        const cost = (dn as number) + graph.cost(e);
        const known = this.stamp[next] === s;
        if (known && (this.closed[next] === 1 || cost >= (this.dist[next] as number))) continue;
        this.stamp[next] = s;
        this.dist[next] = cost;
        this.prev[next] = node;
        this.closed[next] = 0;
        heap.push(next, cost);
      }
    }
    this.lastSettled = settled;
    return true;
  }

  /** 到某点的距离，未达返回 Infinity。 */
  distanceTo(target: number): number {
    if (this.stamp[target] !== this.currentStamp) return Infinity;
    return this.dist[target] as number;
  }

  /** 上一次 run 的源点。 */
  get source(): number {
    return this.lastSource;
  }

  /**
   * 重建到 target 的路径。
   *
   * 返回的 Int32Array 是内部复用的，**下次调用会被覆盖**。
   * 需要长期持有时调用方自己 `slice()` —— 这是刻意的取舍：
   * 每帧几十条路径查询，每条都分配一次数组对 GC 不友好。
   */
  pathTo(target: number): PathResult {
    const s = this.currentStamp;
    if (target < 0 || this.stamp[target] !== s) {
      return { found: false, cost: Infinity, nodes: EMPTY_PATH, hops: 0 };
    }
    // 回溯到源点
    let count = 0;
    let cursor = target;
    while (cursor >= 0 && count < this.pathBuffer.length) {
      this.pathBuffer[count] = cursor;
      count += 1;
      cursor = this.prev[cursor] as number;
    }
    // 反向
    const out = this.pathBuffer.subarray(0, count);
    for (let i = 0; i < count >> 1; i += 1) {
      const j = count - 1 - i;
      const t = out[i] as number;
      out[i] = out[j] as number;
      out[j] = t;
    }
    return { found: true, cost: this.dist[target] as number, nodes: out, hops: count - 1 };
  }

  /** 单次 A*（不缓存最短路树），适合「只问一条路径」的场景。 */
  aStar(from: number, to: number): PathResult {
    if (from === to) {
      this.pathBuffer[0] = from;
      return { found: true, cost: 0, nodes: this.pathBuffer.subarray(0, 1), hops: 0 };
    }
    const graph = this.graph;
    graph.ensureBuilt();
    const n = graph.nodeCount;
    if (from < 0 || from >= n || to < 0 || to >= n) {
      return { found: false, cost: Infinity, nodes: EMPTY_PATH, hops: 0 };
    }

    this.currentStamp += 1;
    const s = this.currentStamp;
    const heap = this.heap;
    heap.clear();
    const h = (node: number): number => {
      if (this.heuristicScale <= 0) return 0;
      const a = graph.nodePos(node);
      const b = graph.nodePos(to);
      return Math.hypot(a.x - b.x, a.z - b.z) * this.heuristicScale;
    };

    this.stamp[from] = s;
    this.dist[from] = 0;
    this.prev[from] = -1;
    this.closed[from] = 0;
    heap.push(from, h(from));

    while (heap.length > 0) {
      const node = heap.pop();
      if (node < 0) break;
      if (this.stamp[node] !== s || this.closed[node] === 1) continue;
      if (node === to) break;
      this.closed[node] = 1;
      const dn = this.dist[node] as number;
      const range = graph.edgeRange(node);
      for (let e = range[0]; e < range[1]; e += 1) {
        const next = graph.target(e);
        const cost = dn + graph.cost(e);
        const known = this.stamp[next] === s;
        if (known && (this.closed[next] === 1 || cost >= (this.dist[next] as number))) continue;
        this.stamp[next] = s;
        this.dist[next] = cost;
        this.prev[next] = node;
        this.closed[next] = 0;
        heap.push(next, cost + h(next));
      }
    }
    return this.pathTo(to);
  }
}
