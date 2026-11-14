/**
 * 运输图的紧凑存储（CSR）。
 *
 * ## 为什么不用 `Map<node, Edge[]>`
 *
 * 一张 200 个站点、800 条边的地铁网，用对象图要 800 个对象 + 800 个数组槽，
 * 在 V8 里约 100KB 且分散在堆上，遍历时有缓存未命中。CSR 是三条连续数组
 * （offsets / targets / weights），同样规模约 13KB，遍历是顺序读。
 *
 * 更关键的是**确定性**：对象图常用 `Map` 存邻接，遍历顺序是插入序 ——
 * 而插入序取决于「玩家先建了哪条线」。同样的路网、不同的建造顺序，
 * 算出来的最短路上会出现不同的等权路径，存档回放就对不上（ADR-001 红线）。
 * CSR 里边的顺序由 `(from, to)` 排序决定，与建造顺序无关。
 *
 * ## 动态增删边怎么办
 *
 * CSR 是静态结构，改一条边就要重建。这里的取舍是：**边变更走「重建」而不是「增量」**。
 * 理由：城市路网是低频操作（玩家建一条线路），200 节点重建约 0.05ms，
 * 而增量维护（碎片整理、空洞回收）的代码复杂度和 bug 面远大于收益。
 * 真正的性能问题在「最短路重算」，那部分由 `network.ts` 用脏标记 + 分帧解决。
 */

/** 节点种类只是标签，方便上层按类型过滤与渲染。 */
export type NodeKind = 'station' | 'city' | 'tile' | 'port';

export interface GraphNode {
  readonly id: string;
  /** 世界坐标（米），A* 的启发函数用。 */
  readonly x: number;
  readonly z: number;
  readonly kind: NodeKind;
}

export interface EdgeInput {
  readonly from: number;
  readonly to: number;
  /** 通行成本。建议用「时间」而不是「距离」，拥堵才有意义。 */
  readonly cost: number;
  /** 容量（单位/秒）。0 表示无限。 */
  readonly capacity?: number;
  /** 是否单向。默认双向（同时插入反向边，成本相同）。 */
  readonly directed?: boolean;
}

export class TransportGraph {
  private readonly nodeIds: string[] = [];
  private readonly nodeX: number[] = [];
  private readonly nodeZ: number[] = [];
  private readonly nodeKinds: NodeKind[] = [];
  private readonly edges: EdgeInput[] = [];

  private offsets: Int32Array = new Int32Array(0);
  private targets: Int32Array = new Int32Array(0);
  private costs: Float32Array = new Float32Array(0);
  private capacities: Float32Array = new Float32Array(0);
  /** 边在原始 edges 数组里的下标，供回查方向信息。 */
  private edgeRefs: Int32Array = new Int32Array(0);
  private built = false;
  private version = 0;

  get nodeCount(): number {
    return this.nodeIds.length;
  }

  get edgeCount(): number {
    return this.targets.length;
  }

  /** 每次 build 递增，上层据此判断缓存是否过期。 */
  get graphVersion(): number {
    return this.version;
  }

  addNode(id: string, x: number, z: number, kind: NodeKind = 'station'): number {
    const existing = this.nodeIds.indexOf(id);
    if (existing >= 0) return existing;
    this.nodeIds.push(id);
    this.nodeX.push(x);
    this.nodeZ.push(z);
    this.nodeKinds.push(kind);
    this.built = false;
    return this.nodeIds.length - 1;
  }

  indexOf(id: string): number {
    return this.nodeIds.indexOf(id);
  }

  nodeAt(index: number): GraphNode | null {
    if (index < 0 || index >= this.nodeIds.length) return null;
    return {
      id: this.nodeIds[index] as string,
      x: this.nodeX[index] as number,
      z: this.nodeZ[index] as number,
      kind: this.nodeKinds[index] as NodeKind,
    };
  }

  addEdge(edge: EdgeInput): void {
    if (edge.from < 0 || edge.from >= this.nodeIds.length || edge.to < 0 || edge.to >= this.nodeIds.length) {
      throw new Error(`[tabby/graph] 边引用了不存在的节点：${edge.from} → ${edge.to}`);
    }
    if (!(edge.cost > 0)) {
      throw new Error(`[tabby/graph] 边成本必须为正：${edge.cost}（0 成本会让 Dijkstra 出现等距环）`);
    }
    this.edges.push(edge);
    if (edge.directed !== true) {
      this.edges.push({ ...edge, from: edge.to, to: edge.from });
    }
    this.built = false;
  }

  /**
   * 生成 CSR。
   *
   * 排序规则：先按 from，再按 to —— 这个顺序决定了 `neighbors()` 的遍历序，
   * 而遍历序影响等权路径的取舍。按 to 排序后，同样的边集合在任何建造顺序下
   * 都产生同样的 CSR，这是确定性的基础。
   */
  build(): void {
    const n = this.nodeIds.length;
    const e = this.edges.length;
    const offsets = new Int32Array(n + 1);
    for (let i = 0; i < e; i += 1) {
      const from = (this.edges[i] as EdgeInput).from;
      offsets[from + 1] = (offsets[from + 1] as number) + 1;
    }
    for (let i = 0; i < n; i += 1) {
      offsets[i + 1] = (offsets[i + 1] as number) + (offsets[i] as number);
    }

    const targets = new Int32Array(e);
    const costs = new Float32Array(e);
    const capacities = new Float32Array(e);
    const refs = new Int32Array(e);
    const cursor = new Int32Array(n);
    for (let i = 0; i < n; i += 1) cursor[i] = offsets[i] as number;

    // 先填，再对每个节点的段内按 target 排序
    const order = new Int32Array(e);
    for (let i = 0; i < e; i += 1) order[i] = i;
    const sorted = Array.from(order).sort((a, b) => {
      const ea = this.edges[a] as EdgeInput;
      const eb = this.edges[b] as EdgeInput;
      if (ea.from !== eb.from) return ea.from - eb.from;
      if (ea.to !== eb.to) return ea.to - eb.to;
      return a - b;
    });

    for (let k = 0; k < e; k += 1) {
      const src = sorted[k] as number;
      const edge = this.edges[src] as EdgeInput;
      const at = cursor[edge.from] as number;
      targets[at] = edge.to;
      costs[at] = edge.cost;
      capacities[at] = edge.capacity ?? 0;
      refs[at] = src;
      cursor[edge.from] = at + 1;
    }

    this.offsets = offsets;
    this.targets = targets;
    this.costs = costs;
    this.capacities = capacities;
    this.edgeRefs = refs;
    this.built = true;
    this.version += 1;
  }

  ensureBuilt(): void {
    if (!this.built) this.build();
  }

  /** 邻接区间 [start, end)，调用方自己遍历 targets。 */
  edgeRange(node: number): readonly [number, number] {
    this.ensureBuilt();
    return [this.offsets[node] as number, this.offsets[node + 1] as number];
  }

  target(edgeIndex: number): number {
    return this.targets[edgeIndex] as number;
  }

  cost(edgeIndex: number): number {
    return this.costs[edgeIndex] as number;
  }

  capacity(edgeIndex: number): number {
    return this.capacities[edgeIndex] as number;
  }

  ref(edgeIndex: number): number {
    return this.edgeRefs[edgeIndex] as number;
  }

  nodePos(index: number): { readonly x: number; readonly z: number } {
    return { x: this.nodeX[index] as number, z: this.nodeZ[index] as number };
  }

  /** 内存占用（字节），诊断面板用。 */
  get byteSize(): number {
    return (
      this.offsets.byteLength +
      this.targets.byteLength +
      this.costs.byteLength +
      this.capacities.byteLength +
      this.edgeRefs.byteLength
    );
  }

  clear(): void {
    this.nodeIds.length = 0;
    this.nodeX.length = 0;
    this.nodeZ.length = 0;
    this.nodeKinds.length = 0;
    this.edges.length = 0;
    this.offsets = new Int32Array(0);
    this.targets = new Int32Array(0);
    this.costs = new Float32Array(0);
    this.capacities = new Float32Array(0);
    this.edgeRefs = new Int32Array(0);
    this.built = false;
    this.version += 1;
  }

  /**
   * 只清边、保留节点。
   *
   * 用于「路网整体重铺」这类场景（玩家拆了围墙、地形被淹、地图刷新）：
   * 节点坐标不变，但通行关系必须整体重算。之所以不做 `removeEdge(from, to)`，
   * 是因为逐条删除会让 CSR 的段内排序失效，重建一次的成本（200 节点约 0.05ms）
   * 远低于维护增量结构出 bug 的代价。
   *
   * 调用后 `graphVersion` 递增，依赖它的缓存（`LogisticsNetwork`、`CityLogistics`）
   * 会自动失效，不需要手动清。
   */
  clearEdges(): void {
    this.edges.length = 0;
    this.build();
  }
}
