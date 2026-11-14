import { RES_COUNT, RES_STRIDE, Resource, type BuildingDef, type EconomyConfig, type ResourceDef } from './types.js';

/**
 * 默认资源表。
 *
 * 数值不是拍脑袋：目标是「一栋田养 20 人」，人口 10 的村子配 1 田就能自持，
 * 稍微盈余靠市场转化成木材。调参只改这里，不要在 systems 里写魔法数字。
 */
export const DEFAULT_RESOURCES: readonly ResourceDef[] = [
  {
    key: 'food',
    label: '食物',
    basePrice: 5,
    elasticity: 0.9,
    targetStock: 60,
  },
  {
    key: 'wood',
    label: '木材',
    basePrice: 8,
    elasticity: 0.7,
    targetStock: 40,
  },
  {
    key: 'goods',
    label: '商品',
    basePrice: 20,
    elasticity: 0.8,
    targetStock: 20,
  },
  {
    key: 'power',
    label: '电力',
    basePrice: 12,
    elasticity: 0.5,
    targetStock: 30,
  },
];

/**
 * 默认建筑表。
 *
 * 顺序即 BuildingDef 下标，**不要重排**——存档里 buildingType 存的是这里的下标。
 * 新增一律追加到末尾。
 */
export const DEFAULT_BUILDINGS: readonly BuildingDef[] = [
  {
    key: 'house',
    label: '住宅',
    category: 'housing',
    output: [],
    input: [],
    capacity: 10,
    jobs: 0,
    upkeep: 2,
    buildCost: 40,
    footprint: 1,
  },
  {
    key: 'farm',
    label: '农田',
    category: 'production',
    output: [[Resource.Food, 6]],
    input: [[Resource.Power, 0.4]],
    capacity: 0,
    jobs: 4,
    upkeep: 3,
    buildCost: 60,
    footprint: 1,
  },
  {
    key: 'sawmill',
    label: '伐木场',
    category: 'production',
    output: [[Resource.Wood, 4]],
    input: [[Resource.Power, 0.6]],
    capacity: 0,
    jobs: 5,
    upkeep: 4,
    buildCost: 80,
    footprint: 1,
  },
  {
    key: 'factory',
    label: '工厂',
    category: 'production',
    output: [[Resource.Goods, 1.5]],
    input: [
      [Resource.Wood, 2],
      [Resource.Power, 1.2],
    ],
    capacity: 0,
    jobs: 8,
    upkeep: 7,
    buildCost: 140,
    footprint: 1,
  },
  {
    key: 'powerplant',
    label: '发电站',
    category: 'infrastructure',
    output: [[Resource.Power, 8]],
    input: [],
    capacity: 0,
    jobs: 3,
    upkeep: 9,
    buildCost: 180,
    footprint: 2,
  },
];

export const DEFAULT_CONFIG: EconomyConfig = {
  entityCapacity: 4096,
  cityCount: 1,
  seed: 0x7a6b79,
  taxRate: 0.12,
  foodPerCapita: 0.05,
  incomePerCapita: 3,
  daysPerTick: 1,
  daysPerMonth: 30,
  monthsPerYear: 12,
};

/**
 * 校验外部传入的配置与定义表。
 *
 * 为什么在构造期一次性抛错，而不是运行期兜底：
 * 经济结算是纯函数式的批量循环，运行期兜底会让「某个资源没定义」这种事
 * 变成每天静默吞掉一半产出，排查成本远高于启动时直接崩。
 */
export function validateResources(defs: readonly ResourceDef[]): void {
  if (defs.length === 0) throw new Error('[tabby/economy] 资源表不能为空');
  if (defs.length > RES_COUNT) {
    throw new Error(`[tabby/economy] 资源表超出当前实现的 ${RES_COUNT} 种（stride ${RES_STRIDE}）`);
  }
  for (let i = 0; i < defs.length; i += 1) {
    const def = defs[i] as ResourceDef;
    if (!(def.basePrice > 0)) throw new Error(`[tabby/economy] 资源 ${def.key} 的 basePrice 必须 > 0`);
    if (!(def.elasticity > 0 && def.elasticity <= 2)) {
      throw new Error(`[tabby/economy] 资源 ${def.key} 的 elasticity 必须在 (0, 2]`);
    }
    if (!(def.targetStock >= 0)) throw new Error(`[tabby/economy] 资源 ${def.key} 的 targetStock 不能为负`);
  }
}

export function validateBuildings(defs: readonly BuildingDef[], resourceCount: number): void {
  if (defs.length === 0) throw new Error('[tabby/economy] 建筑表不能为空');
  for (let i = 0; i < defs.length; i += 1) {
    const def = defs[i] as BuildingDef;
    for (const [res] of [...def.output, ...def.input]) {
      if (!Number.isInteger(res) || res < 0 || res >= resourceCount) {
        throw new Error(`[tabby/economy] 建筑 ${def.key} 引用了不存在的资源下标 ${res}`);
      }
    }
    if (!(def.upkeep >= 0) || !(def.buildCost >= 0)) {
      throw new Error(`[tabby/economy] 建筑 ${def.key} 的 upkeep/buildCost 不能为负`);
    }
    if (def.footprint < 1) throw new Error(`[tabby/economy] 建筑 ${def.key} 的 footprint 至少为 1`);
    if (def.category === 'housing' && def.capacity <= 0) {
      throw new Error(`[tabby/economy] 住房 ${def.key} 的 capacity 必须 > 0`);
    }
  }
}

/** 按 key 查建筑下标，仅用于启动期配置，不进结算热路径。 */
export function buildingIndexOf(defs: readonly BuildingDef[], key: string): number {
  for (let i = 0; i < defs.length; i += 1) {
    if ((defs[i] as BuildingDef).key === key) return i;
  }
  return -1;
}
