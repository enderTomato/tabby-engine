import type { LogisticsNetwork } from './network.js';

/**
 * 地块级的运输成本接口。
 *
 * 约定：
 * - 返回 **0** 表示「没有运输需求」（同一个地块、或任一地块没接入路网）；
 * - 返回 **Infinity** 表示「不可达」；
 * - 其它值是与「距离/时间」同量纲的正数。
 */
export interface TileCostProvider {
  transportCost(fromTile: number, toTile: number): number;
}

/**
 * 把地块编号映射到图节点的适配器。
 *
 * 只做映射与转发，不含任何策略。策略（哪些建筑要连路、成本怎么折算）
 * 属于玩法层，应该写在 demo 或经济层的配置里，而不是这里。
 */
export class TileLogistics implements TileCostProvider {
  readonly network: LogisticsNetwork;
  private readonly tileToNode = new Map<number, number>();
  /** 单次运输成本上限，超过按上限算（防止一个离谱的图把效率压成 0）。 */
  private readonly costCeiling: number;
  private queryCount = 0;

  constructor(network: LogisticsNetwork, costCeiling = 100) {
    this.network = network;
    this.costCeiling = Math.max(1, costCeiling);
  }

  get queries(): number {
    return this.queryCount;
  }

  bind(tile: number, node: number): void {
    this.tileToNode.set(tile, node);
  }

  unbind(tile: number): void {
    this.tileToNode.delete(tile);
  }

  nodeOf(tile: number): number {
    return this.tileToNode.get(tile) ?? -1;
  }

  transportCost(fromTile: number, toTile: number): number {
    if (fromTile === toTile) return 0;
    this.queryCount += 1;
    const from = this.tileToNode.get(fromTile);
    const to = this.tileToNode.get(toTile);
    // 任一地块没接入路网 → 视为本地自给，不惩罚。
    // 反过来（没接入就判不可达）会让「刚放下还没连路」的建筑全部停摆，
    // 对玩家是不可理解的惩罚。
    if (from === undefined || to === undefined) return 0;
    const cost = this.network.cost(from, to);
    if (!Number.isFinite(cost)) return Infinity;
    return Math.min(cost, this.costCeiling);
  }
}

/**
 * 经济层看到的物流接口。
 *
 * **这是结构化类型，故意不 import `@tabby/economy`**：两个包互不依赖，
 * 但 `CityLogistics` 可以直接传给 `new Economy({ logistics })`。
 * 如果哪天经济层改了签名，这里会在编译期报「属性不匹配」，
 * 而不是等到运行时才发现在静默返回 undefined。
 */
export interface EfficiencyLogisticsProvider {
  /** 返回 [0, 1] 的产出系数，0 表示完全断供，1 表示通畅。 */
  efficiencyOf(buildingId: number, city: number): number;
}

export interface CityLogisticsOptions {
  /** 城市数量。默认 1。 */
  readonly cityCount?: number;
  /** 预分配的建筑容量，超出后自动翻倍扩容。默认 512。 */
  readonly buildingCapacity?: number;
  /** 低于此距离不惩罚（「门口就是路」）。默认 12。 */
  readonly freeDistance?: number;
  /** 高于此距离效率归零。默认 90。 */
  readonly zeroDistance?: number;
  /**
   * 建筑没接入路网时的效率。默认 1（不惩罚）。
   *
   * 默认不惩罚是有意的：建筑刚放下、路还没铺完是常态，此时扣产出会让玩家长按
   * 一栋楼看不到任何产出，却查不出原因。真正的惩罚应该来自「连了路但不通」。
   */
  readonly unboundEfficiency?: number;
}

/** 成本 → 效率的折算（纯函数，方便单测与调参）。 */
export function efficiencyFromCost(
  cost: number,
  freeDistance = 12,
  zeroDistance = 90,
): number {
  if (!Number.isFinite(cost)) return 0;
  if (cost <= freeDistance) return 1;
  if (cost >= zeroDistance) return 0;
  const span = zeroDistance - freeDistance;
  if (!(span > 0)) return cost <= freeDistance ? 1 : 0;
  return 1 - (cost - freeDistance) / span;
}

/**
 * 建筑 → 城市枢纽 的物流效率适配器（经济层的 `LogisticsProvider` 实现）。
 *
 * ## 为什么是「到枢纽的距离」而不是「建筑到建筑」
 *
 * 经济内核是城市级的库存模型（`cityStock[city][res]`），没有「A 厂把货送到 B 店」
 * 这一层实体。硬造 OD 对会得到一张 O(建筑²) 的查询矩阵，500 栋楼就是 25 万次查询/天。
 *
 * 所以模型取近似：**每栋建筑必须连到本城市的枢纽（市政中心 / 车站）**，
 * 断供就是「连不上枢纽」。这是单源问题 —— 每个城市一棵最短路树，
 * 查询退化成一次数组读取，与建筑数量无关。
 *
 * ## 缓存三层
 *
 * ```
 * 1. efficiency[buildingId]  Float32Array     建筑 → 效率，-1 表示未算
 * 2. network.caches[hubNode]  单源最短路树     枢纽 → 全图距离
 * 3. CSR                     图结构本身
 * ```
 *
 * 任一层失效（建筑换位置、路网重建）都要让上层作废。反过来的顺序不行：
 * 只作废第一层而留着旧的距离树，会算出「路已经拆了但还是通的」。
 */
export class CityLogistics implements EfficiencyLogisticsProvider {
  readonly tiles: TileLogistics;
  cities: number;

  private freeDistance: number;
  private zeroDistance: number;
  private readonly unboundEfficiency: number;

  /** `city → hub tile`，-1 表示该城市没有枢纽。 */
  private hubTile: Int32Array;
  /** `buildingId → tile`，-1 表示未绑定。 */
  private buildingTile: Int32Array;
  /** `buildingId → efficiency`，-1 表示未算。 */
  private efficiency: Float32Array;
  /**
   * `buildingId → 该效率是按哪个城市算的`。
   *
   * 缓存键必须含城市：同一栋建筑在 city 0 的枢纽下是 1，在 city 1 的枢纽下可能是 0.3。
   * 只用 buildingId 做键的话，先问 city 0 再问 city 1 会直接返回 city 0 的旧值 ——
   * 这类 bug 在多城市地图上表现为「城郊的厂莫名其妙被上游城市带飞」，极难定位。
   */
  private cacheCity: Int32Array;
  /** 缓存对应的图版本；不一致就整体作废。 */
  private cachedVersion = -1;

  private queries = 0;
  private misses = 0;

  constructor(tiles: TileLogistics, options: CityLogisticsOptions = {}) {
    const cities = Math.max(1, Math.floor(options.cityCount ?? 1));
    const capacity = Math.max(1, Math.floor(options.buildingCapacity ?? 512));

    this.tiles = tiles;
    this.cities = cities;
    this.freeDistance = Math.max(0, options.freeDistance ?? 12);
    this.zeroDistance = Math.max(this.freeDistance + 1, options.zeroDistance ?? 90);
    this.unboundEfficiency = clamp01(options.unboundEfficiency ?? 1);

    this.hubTile = new Int32Array(cities).fill(-1);
    this.buildingTile = new Int32Array(capacity).fill(-1);
    this.efficiency = new Float32Array(capacity).fill(-1);
    this.cacheCity = new Int32Array(capacity).fill(-1);
  }

  /** 查询次数（含命中），诊断用。 */
  get queryCount(): number {
    return this.queries;
  }

  /** 真正跑了路径计算的次数，诊断用。命中缓存时不增加。 */
  get missCount(): number {
    return this.misses;
  }

  /**
   * 调整效率曲线的两个拐点。
   *
   * 这是**玩法调参**接口（调试面板、难度选项），不是性能旋钮。
   * 改完必须让效率缓存作废，否则已经算过的建筑会继续用旧曲线 ——
   * 症状是「调了参数，只有新盖的楼生效」。
   */
  setCurve(freeDistance: number, zeroDistance: number): void {
    const free = Math.max(0, freeDistance);
    const zero = Math.max(free + 1, zeroDistance);
    if (free === this.freeDistance && zero === this.zeroDistance) return;
    this.freeDistance = free;
    this.zeroDistance = zero;
    this.invalidate();
  }

  get curve(): { readonly freeDistance: number; readonly zeroDistance: number } {
    return { freeDistance: this.freeDistance, zeroDistance: this.zeroDistance };
  }

  /** 设置城市的枢纽地块。 */
  setHub(city: number, tile: number): void {
    if (!this.validCity(city)) return;
    this.ensureCities(city);
    this.hubTile[city] = tile;
    this.invalidate();
  }

  hubOf(city: number): number {
    if (!this.validCity(city)) return -1;
    return this.hubTile[city] as number;
  }

  /** 建筑绑定到地块。拆除建筑时记得 `unbindBuilding`，否则槽位复用后会继承旧效率。 */
  bindBuilding(buildingId: number, tile: number): boolean {
    if (buildingId < 0) return false;
    this.ensureCapacity(buildingId);
    this.buildingTile[buildingId] = tile;
    this.efficiency[buildingId] = -1;
    this.cacheCity[buildingId] = -1;
    return true;
  }

  unbindBuilding(buildingId: number): void {
    if (buildingId < 0 || buildingId >= this.buildingTile.length) return;
    this.buildingTile[buildingId] = -1;
    this.efficiency[buildingId] = -1;
    this.cacheCity[buildingId] = -1;
  }

  tileOf(buildingId: number): number {
    if (buildingId < 0 || buildingId >= this.buildingTile.length) return -1;
    return this.buildingTile[buildingId] as number;
  }

  /**
   * 清空所有建筑绑定。
   *
   * 读档、换地图时必须调用：此时经济层的实体池整体替换，旧 id 会被复用，
   * 留着旧绑定就会出现「新房子继承了上一局某个厂的通断状态」。
   */
  clearBuildings(): void {
    this.buildingTile.fill(-1);
    this.efficiency.fill(-1);
    this.cacheCity.fill(-1);
  }

  /**
   * 让全部效率缓存作废，并把各城市枢纽的最短路树标脏。
   *
   * 路网变更（铺路、拆路、单向限行）后必须调用。**不调用不会算错**
   * ——`network.cost` 会发现图版本变了而退回 A* 现算——但那意味着
   * 「每栋楼每 tick 一次 A*」，是这层缓存存在的唯一原因。
   */
  invalidate(): void {
    this.efficiency.fill(-1);
    this.cacheCity.fill(-1);
    this.cachedVersion = -1;
    for (let city = 0; city < this.hubTile.length; city += 1) {
      const tile = this.hubTile[city] as number;
      if (tile < 0) continue;
      const node = this.tiles.nodeOf(tile);
      if (node >= 0) this.tiles.network.markSourcesDirty([node]);
    }
  }

  /**
   * 分帧重算脏源。返回仍未算完的源点数。
   *
   * 每帧调一次，budget 取 1~2。城市数量少（通常 1~4），所以实际上第一帧就全算完了；
   * 留分帧是因为地图编辑器的「刷一条路」会连续产生几十次变更。
   */
  refresh(budget = 2): number {
    return this.tiles.network.recompute(budget);
  }

  /** 一次算完（读档、时间跳变后使用）。 */
  refreshAll(): void {
    this.invalidate();
    this.tiles.network.recomputeAll();
  }

  efficiencyOf(buildingId: number, city: number): number {
    this.queries += 1;

    if (!Number.isInteger(buildingId) || buildingId < 0) return this.unboundEfficiency;
    this.ensureCapacity(buildingId);

    const version = this.tiles.network.graph.graphVersion;
    if (version !== this.cachedVersion) {
      this.efficiency.fill(-1);
      this.cacheCity.fill(-1);
      this.cachedVersion = version;
    }

    const cached = this.efficiency[buildingId] as number;
    // 用 -1 而不是 NaN 做哨兵：Float32Array 里 NaN 的读写在某些引擎上会被规范化，
    // 而 -1 在效率的正数域里永远不会是合法值，比较也更便宜。
    if (cached >= 0 && this.cacheCity[buildingId] === city) return cached;

    this.misses += 1;
    const value = this.compute(buildingId, city);
    this.efficiency[buildingId] = value;
    this.cacheCity[buildingId] = city;
    return value;
  }

  /** 效率落到 0 的建筑数量。O(capacity)，只在诊断面板里调。 */
  blockedCount(limit = this.buildingTile.length): number {
    let n = 0;
    for (let i = 0; i < Math.min(limit, this.efficiency.length); i += 1) {
      if (this.buildingTile[i] === -1) continue;
      if ((this.efficiency[i] as number) === 0) n += 1;
    }
    return n;
  }

  private compute(buildingId: number, city: number): number {
    const tile = this.buildingTile[buildingId] as number;
    if (tile < 0) return this.unboundEfficiency;

    const from = this.tiles.nodeOf(tile);
    if (from < 0) return this.unboundEfficiency;

    if (!this.validCity(city)) return this.unboundEfficiency;
    const hubTile = this.hubTile[city] as number;
    if (hubTile < 0) return this.unboundEfficiency;

    const to = this.tiles.nodeOf(hubTile);
    if (to < 0) return this.unboundEfficiency;
    if (from === to) return 1;

    // 方向固定为「枢纽 → 建筑」：枢纽数量少（1~4），最短路树天然以它为源，
    // 缓存命中率最高。单行道反向不通会被算成不可达 —— 这正是运不进来的语义。
    const cost = this.tiles.network.cost(to, from);
    return efficiencyFromCost(cost, this.freeDistance, this.zeroDistance);
  }

  private validCity(city: number): boolean {
    return Number.isInteger(city) && city >= 0 && city < this.cities;
  }

  private ensureCities(city: number): void {
    if (city < this.cities) return;
    const next = new Int32Array(city + 1).fill(-1);
    next.set(this.hubTile);
    this.hubTile = next;
    this.cities = city + 1;
  }

  private ensureCapacity(buildingId: number): void {
    if (buildingId < this.buildingTile.length) return;
    let next = this.buildingTile.length;
    while (next <= buildingId) next *= 2;
    const tiles = new Int32Array(next).fill(-1);
    tiles.set(this.buildingTile);
    const eff = new Float32Array(next).fill(-1);
    eff.set(this.efficiency);
    const cities = new Int32Array(next).fill(-1);
    cities.set(this.cacheCity);
    this.buildingTile = tiles;
    this.efficiency = eff;
    this.cacheCity = cities;
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
