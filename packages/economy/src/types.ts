/**
 * 经济层公开类型。
 *
 * 这个文件刻意不 import 任何东西 —— 连 @tabby/core 都不 import，
 * 保证类型定义本身零依赖，下游（编辑器 UI、存档工具）可以单独引用。
 */

/**
 * 资源下标。
 *
 * 为什么用数字下标而不是字符串 key：结算时每帧要跑 `实体数 × 资源数` 次访问，
 * 字符串哈希在 10k 实体 × 每 tick 多次会变成主要开销。数字下标直接是数组偏移。
 *
 * 为什么不用 enum：`isolatedModules` 下 const enum 被禁，普通 enum 会生成运行时对象，
 * 而我们要的是「编译期就定死的常量」——对象字面量 + as const 达成同样效果且可 tree-shake。
 */
export const Resource = {
  Food: 0,
  Wood: 1,
  Goods: 2,
  Power: 3,
} as const;

export type ResourceIndex = (typeof Resource)[keyof typeof Resource];

/**
 * 数组物理步长。**不等于**当前资源种类数。
 *
 * 为什么留空位：存档里 stock 是 `实体 × stride` 的连续块。如果 stride 跟着资源种类走，
 * 以后加一种资源就得写 v1→v2 迁移把整个块重排。固定 8 个槽位、只用前 N 个，
 * 新增资源直接占空位，老存档不用动 —— 10k 实体浪费的 40KB 换掉一整条迁移链。
 */
export const RES_STRIDE = 8;

/** 当前启用的资源种类数（≤ RES_STRIDE）。 */
export const RES_COUNT = 4;

/** 金库上下界。Int32 上限 2147483647，留 1500 万安全余量防回绕。 */
export const TREASURY_MAX = 2_000_000_000;
export const TREASURY_MIN = 0;

export interface ResourceDef {
  /** 存档与日志用的稳定标识，**不要**拿来做运行时查找。 */
  readonly key: string;
  readonly label: string;
  /** 价格中枢，市场围绕它波动。 */
  readonly basePrice: number;
  /** 0.3~1.2。越大价格对供需越敏感。 */
  readonly elasticity: number;
  /** 目标储备：demand = 本期消耗 + 缺口储备。 */
  readonly targetStock: number;
}

/** 建筑配方里的一项：`[资源下标, 数量]`。用数组对而不用对象，避免结算时遍历对象键。 */
export type ResourceAmount = readonly [ResourceIndex, number];

export type BuildingCategory = 'housing' | 'production' | 'infrastructure';

export interface BuildingDef {
  readonly key: string;
  readonly label: string;
  readonly category: BuildingCategory;
  /** 单 tick 满效率产出。 */
  readonly output: readonly ResourceAmount[];
  /** 单 tick 满效率消耗。 */
  readonly input: readonly ResourceAmount[];
  /** 住房容量（人口）。非住宅为 0。 */
  readonly capacity: number;
  /** 岗位数，影响就业率与满意度。 */
  readonly jobs: number;
  /** 每月维护费（金币）。 */
  readonly upkeep: number;
  /** 建造一次性成本，走指令队列扣款。 */
  readonly buildCost: number;
  /** 占地格数，1 = 单格。 */
  readonly footprint: number;
}

export interface EconomyConfig {
  /** 实体槽位上限。超出后 placeBuilding 失败并返回 -1。 */
  readonly entityCapacity: number;
  /** 城市数量（至少 1）。默认 1。 */
  readonly cityCount: number;
  /** PRNG 种子，随存档保存。 */
  readonly seed: number;
  /** 默认税率 0~1。 */
  readonly taxRate: number;
  /** 每人每 tick 食物消耗。 */
  readonly foodPerCapita: number;
  /** 每人每月税基（金币），再乘税率与满意度。 */
  readonly incomePerCapita: number;
  /** 每 tick 折算的天数，仅用于时间显示，不影响结算。 */
  readonly daysPerTick: number;
  readonly daysPerMonth: number;
  readonly monthsPerYear: number;
}

/**
 * 物流查询接口（依赖倒置）。
 *
 * 经济层不认识 `@tabby/graph`，只认识这个 interface —— 这样可以单独发布、
 * 单独单测（那 20 项测试跑在纯 Node 里，没有任何图结构），
 * 上层也能换成「全部免费」的简化实现。
 *
 * 实现方（demo 或 graph 包的适配器）负责把 buildingId 映射到地块/图节点。
 */
export interface LogisticsProvider {
  /**
   * 该建筑本 tick 的运输效率系数，取值 [0, 1]。
   *
   * - 1 表示运输通畅，无惩罚；
   * - 0 表示补给中断，该建筑停产；
   * - 中间值按比例缩产。
   *
   * 调用频率是「每建筑每 tick 一次」，实现方必须自己缓存，
   * 不要在里面跑最短路。
   */
  efficiencyOf(buildingId: number, city: number): number;
}

export interface EconomyOptions extends Partial<EconomyConfig> {
  readonly resourceDefs?: readonly ResourceDef[];
  readonly buildingDefs?: readonly BuildingDef[];
  /**
   * 可选的耗时时钟。不传时 `lastDayMs` 恒为 0 —— 这是有意的：
   * 内核本身不许读 `performance.now()`，否则它就没法在 Worker / Node / 服务端跑。
   * 需要性能数据的地方（demo 的诊断面板）自己注入一个。
   */
  readonly clock?: () => number;
  /** 物流接口。不传表示没有物流系统，所有建筑按满效率运行。 */
  readonly logistics?: LogisticsProvider | null;
}

/** 城市级只读快照，给 UI / 诊断用。结算内部不构造对象。 */
export interface CitySnapshot {
  readonly id: number;
  /** 可能带小数（日增量常小于 1）。要显示人数请自己 `Math.round`。 */
  readonly population: number;
  readonly taxRate: number;
  readonly satisfaction: number;
  readonly treasury: number;
  readonly housing: number;
  readonly jobs: number;
  readonly employed: number;
  readonly starving: boolean;
}

export interface EconomyDiagnostics {
  readonly day: number;
  readonly month: number;
  readonly year: number;
  readonly tick: number;
  readonly aliveBuildings: number;
  readonly totalPopulation: number;
  readonly moneySupply: number;
  readonly gdp: number;
  readonly inflationRatio: number;
  readonly lastDayMs: number;
  readonly lastMonthMs: number;
  readonly prices: readonly number[];
}

export type EconomyCommand =
  | { readonly type: 'place-building'; readonly city: number; readonly tile: number; readonly def: number }
  | { readonly type: 'remove-building'; readonly id: number }
  | { readonly type: 'set-tax'; readonly city: number; readonly rate: number }
  | { readonly type: 'deposit'; readonly city: number; readonly amount: number };

export interface TickReport {
  readonly dayTicks: number;
  readonly monthTicks: number;
  readonly yearTicks: number;
  /** 本帧因 backlog 上限被丢弃（跳帧不结算）的 tick 数。 */
  readonly skipped: number;
}

/** 经济层能问地形什么。只给数字与布尔，不给 HeightField 引用，避免反向耦合。 */
export interface TerrainQuery {
  isBuildable(tileIndex: number): boolean;
  isUnderwater(tileIndex: number): boolean;
  slope(tileIndex: number): number;
}

export interface EconomyEvents {
  'day-tick': { readonly day: number; readonly month: number; readonly year: number };
  'month-end': {
    readonly year: number;
    readonly month: number;
    readonly taxIncome: number;
    readonly upkeep: number;
    readonly treasury: number;
  };
  'year-end': { readonly year: number; readonly population: number; readonly gdp: number };
  famine: { readonly city: number; readonly ratio: number };
  bankrupt: { readonly city: number; readonly treasury: number };
  boom: { readonly city: number; readonly population: number };
  'tick-skipped': { readonly count: number; readonly day: number };
  /** 走指令队列放置时也需要拿到实体 id，否则调用方无法再对它发指令。 */
  'building-placed': { readonly id: number; readonly city: number; readonly tile: number; readonly def: number };
  /** `tile` 是拆除前的格子下标：实体销毁后 `state.buildingTile[id]` 是 -1，订阅方只能靠它定位。 */
  'building-removed': { readonly id: number; readonly city: number; readonly def: number; readonly tile: number };
  /** 物流中断：某城市的受阻建筑数超过阈值。每个城市每天最多发一次。 */
  'logistics-blocked': { readonly city: number; readonly blocked: number; readonly total: number };
  warning: { readonly code: string; readonly message: string };
}
