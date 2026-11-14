import { RES_STRIDE } from './types.js';

/**
 * 经济状态：全部实体与派生数据都存在定长 TypedArray 里。
 *
 * 三条不可动摇的约定：
 *
 * 1. **不 splice**。删除只把 `alive[i]` 置 0，槽位进 free-list 等复用。
 *    splice 会让后面所有 id 前移，任何持有 id 的地方（指令队列、存档里的引用）立刻失效。
 * 2. **遍历用下标**。`for (let i = 0; i < capacity; i++)`，不遍历 Map / Object.keys。
 *    整数键的遍历顺序在 JS 引擎间实现细节不同，这是确定性的红线。
 * 3. **临时量不进存档**。带 `scratch` 前缀的数组是每 tick 重算的中间结果，
 *    序列化时跳过 —— 让它们进存档只会在版本迁移时多出一堆无意义的兼容分支。
 */
export class EconomyState {
  readonly capacity: number;
  readonly cityCount: number;
  readonly resourceCount: number;

  /** 1 = 存活，0 = 墓碑。 */
  readonly alive: Uint8Array;
  readonly buildingType: Uint16Array;
  /** 所属城市下标，-1 表示无所属（理论上不出现，留作异常标记）。 */
  readonly buildingCity: Int32Array;
  /** 地形格子下标，-1 表示未落位（用于「已规划未建成」的中间态）。 */
  readonly buildingTile: Int32Array;
  /** 0..1，受维护费未付、输入短缺影响。低于 0.3 视为停摆。 */
  readonly buildingEfficiency: Float32Array;

  /**
   * 每城市人口。**允许小数**：日增量常小于 1（小城市 8 人时约 0.29/天），
   * 取整会把增长完全吃掉。展示层自己 round，内核只管算准。
   */
  readonly cityPopulation: Float32Array;
  readonly cityTaxRate: Float32Array;
  readonly citySatisfaction: Float32Array;
  /** 每城市金库，整数域。用 Int32 而不是 Float32：金币超过 1600 万后 Float32 会丢个位。 */
  readonly cityTreasury: Int32Array;
  /** 城市库存，`city * RES_STRIDE + resource`。 */
  readonly cityStock: Float32Array;

  /** 每城市住房容量与岗位数，每 tick 由建筑聚合得出。 */
  readonly cityHousing: Float32Array;
  readonly cityJobs: Float32Array;
  readonly cityEmployed: Float32Array;
  /** 本 tick 食物缺口比例，0 = 充足。 */
  readonly cityFoodShortage: Float32Array;

  readonly price: Float32Array;
  readonly priceTarget: Float32Array;
  /** 本日产量 / 消耗量，用于市场结算。 */
  readonly scratchProduced: Float32Array;
  readonly scratchConsumed: Float32Array;
  /**
   * 本 tick 每栋建筑的物流系数，由 `runProduction` 写入、`runLogistics` 读取。
   *
   * 存在的理由是**只问一次**：物流 provider 可能是图查询实现，
   * 生产统计各调一次就是双倍开销，而且两次调用之间若 provider 状态变了
   * （路网刚重算），会出现「产出按 0.8 算、事件统计按 0 算」的自相矛盾。
   */
  readonly scratchLogistics: Float32Array;

  day = 1;
  month = 1;
  year = 1;
  tick = 0;

  private readonly freeList: Int32Array;
  private freeTop = 0;
  private aliveCount = 0;

  constructor(capacity: number, cityCount: number, resourceCount: number) {
    if (capacity < 1) throw new Error('[tabby/economy] entityCapacity 至少为 1');
    if (cityCount < 1) throw new Error('[tabby/economy] cityCount 至少为 1');
    this.capacity = Math.floor(capacity);
    this.cityCount = Math.floor(cityCount);
    this.resourceCount = resourceCount;

    this.alive = new Uint8Array(this.capacity);
    this.buildingType = new Uint16Array(this.capacity);
    this.buildingCity = new Int32Array(this.capacity).fill(-1);
    this.buildingTile = new Int32Array(this.capacity).fill(-1);
    this.buildingEfficiency = new Float32Array(this.capacity);

    const citySlots = this.cityCount * RES_STRIDE;
    this.cityPopulation = new Float32Array(this.cityCount);
    this.cityTaxRate = new Float32Array(this.cityCount);
    this.citySatisfaction = new Float32Array(this.cityCount);
    this.cityTreasury = new Int32Array(this.cityCount);
    this.cityStock = new Float32Array(citySlots);
    this.cityHousing = new Float32Array(this.cityCount);
    this.cityJobs = new Float32Array(this.cityCount);
    this.cityEmployed = new Float32Array(this.cityCount);
    this.cityFoodShortage = new Float32Array(this.cityCount);

    this.price = new Float32Array(RES_STRIDE);
    this.priceTarget = new Float32Array(RES_STRIDE);
    this.scratchProduced = new Float32Array(citySlots);
    this.scratchConsumed = new Float32Array(citySlots);
    this.scratchLogistics = new Float32Array(this.capacity).fill(1);

    // 倒序排布后 pop，保证首次分配的 id 是 0、1、2…（与「创建顺序」一致，便于人工读存档）
    this.freeList = new Int32Array(this.capacity);
    for (let i = 0; i < this.capacity; i += 1) this.freeList[i] = this.capacity - 1 - i;
    this.freeTop = this.capacity;
  }

  get aliveBuildings(): number {
    return this.aliveCount;
  }

  get freeSlots(): number {
    return this.freeTop;
  }

  /** 分配一个槽位，返回实体 id；池满返回 -1。 */
  allocate(type: number, city: number, tile: number): number {
    if (this.freeTop === 0) return -1;
    this.freeTop -= 1;
    const id = this.freeList[this.freeTop] as number;
    this.alive[id] = 1;
    this.buildingType[id] = type;
    this.buildingCity[id] = city;
    this.buildingTile[id] = tile;
    this.buildingEfficiency[id] = 1;
    this.aliveCount += 1;
    return id;
  }

  /** 墓碑删除。重复删除是幂等的，不报错 —— 指令队列可能重放。 */
  destroy(id: number): boolean {
    if (id < 0 || id >= this.capacity) return false;
    if (this.alive[id] === 0) return false;
    this.alive[id] = 0;
    this.buildingType[id] = 0;
    this.buildingCity[id] = -1;
    this.buildingTile[id] = -1;
    this.buildingEfficiency[id] = 0;
    this.freeList[this.freeTop] = id;
    this.freeTop += 1;
    this.aliveCount -= 1;
    return true;
  }

  stockOf(city: number, resource: number): number {
    return this.cityStock[city * RES_STRIDE + resource] ?? 0;
  }

  setStock(city: number, resource: number, value: number): void {
    this.cityStock[city * RES_STRIDE + resource] = value;
  }

  addStock(city: number, resource: number, delta: number): void {
    const at = city * RES_STRIDE + resource;
    this.cityStock[at] = (this.cityStock[at] ?? 0) + delta;
  }

  clearScratch(): void {
    this.scratchProduced.fill(0);
    this.scratchConsumed.fill(0);
    // 默认 1 而不是 0：没跑生产的建筑（住宅）不该被当成断供。
    this.scratchLogistics.fill(1);
    this.cityHousing.fill(0);
    this.cityJobs.fill(0);
    this.cityEmployed.fill(0);
    this.cityFoodShortage.fill(0);
  }

  /** 深拷贝一份（测试与回放用，不要在热路径调用）。 */
  clone(): EconomyState {
    const copy = new EconomyState(this.capacity, this.cityCount, this.resourceCount);
    copy.alive.set(this.alive);
    copy.buildingType.set(this.buildingType);
    copy.buildingCity.set(this.buildingCity);
    copy.buildingTile.set(this.buildingTile);
    copy.buildingEfficiency.set(this.buildingEfficiency);
    copy.cityPopulation.set(this.cityPopulation);
    copy.cityTaxRate.set(this.cityTaxRate);
    copy.citySatisfaction.set(this.citySatisfaction);
    copy.cityTreasury.set(this.cityTreasury);
    copy.cityStock.set(this.cityStock);
    copy.price.set(this.price);
    copy.priceTarget.set(this.priceTarget);
    copy.day = this.day;
    copy.month = this.month;
    copy.year = this.year;
    copy.tick = this.tick;
    return copy;
  }
}

/** 需要随存档持久化的数组清单。新增字段记得加进来，否则重放会悄悄不一致。 */
export const PERSISTED_FIELDS = [
  'alive',
  'buildingType',
  'buildingCity',
  'buildingTile',
  'buildingEfficiency',
  'cityPopulation',
  'cityTaxRate',
  'citySatisfaction',
  'cityTreasury',
  'cityStock',
  'price',
  'priceTarget',
] as const;

export type PersistedField = (typeof PERSISTED_FIELDS)[number];

export function persistedArray(state: EconomyState, field: PersistedField): ArrayBufferView {
  return state[field];
}
