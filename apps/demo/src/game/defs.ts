/**
 * Demo 的资源配置与建筑配方。
 *
 * 为什么不直接用 `DEFAULT_RESOURCES` / `DEFAULT_BUILDINGS`：
 * 默认表是给「完整经营游戏」准备的（4 资源 5 建筑、发电站供能），
 * 而这个测试用例只有 4 个工具栏按钮。硬套默认表会有两个直接后果：
 *
 * 1. 农田的 `input` 里有 0.4 电力，而 demo 没有发电站 —— 电力库存恒为 0，
 *    `runProduction` 按 `have / amount` 缩产到 0，于是「田建好了人照样饿死」。
 * 2. 默认伐木场/工厂/发电站永远建不出来，却会参与存档、价格、GDP 统计。
 *
 * 所以这里自建一张小表。**顺序不能重排**：`buildingType` 存的就是这张表的下标，
 * house=0 / farm=1 与默认表一致，追加的 wall 放在末尾 —— 万一以后换成默认表，
 * 老存档仍然读得对。
 */

import { Resource, type BuildingDef, type EconomyConfig, type ResourceDef } from '@tabby/economy';

/**
 * demo 只用一种资源。
 *
 * 只有一种资源时价格系统依然有意义：丰收时粮价跌、饥荒时飙，
 * HUD 上的粮价就是「当前经济健康度」的直观读数。
 * 加第二种资源需要给它一条产出链（伐木场），那会让工具栏从 4 个按钮变成 6 个，
 * 而测试用例要验证的是引擎链路，不是玩法深度。
 */
export const DEMO_RESOURCES: readonly ResourceDef[] = [
  {
    key: 'food',
    label: '食物',
    basePrice: 5,
    elasticity: 0.9,
    targetStock: 40,
  },
];

/** 建筑定义下标。用具名常量而不是裸数字 0/1/2，改表顺序时编译期就会炸。 */
export const DEF = {
  House: 0,
  Farm: 1,
  Wall: 2,
} as const;

export const DEMO_BUILDINGS: readonly BuildingDef[] = [
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
    // 无输入：见文件头注释。产出 6 食物/日，够 120 人吃（foodPerCapita 0.05）。
    // 数值偏宽松是故意的 —— 玩家永远不该在「刚建好第一块田」时被饿死。
    output: [[Resource.Food, 6]],
    input: [],
    capacity: 0,
    jobs: 4,
    upkeep: 3,
    buildCost: 60,
    footprint: 1,
  },
  {
    key: 'wall',
    label: '挡板',
    category: 'infrastructure',
    output: [],
    input: [],
    capacity: 0,
    jobs: 0,
    // 维护费 0.5 而不是 0：挡板是这个 demo 里唯一能改造水流走向的物件，
    // 免费的话最优解就是「整张图铺满挡板」，玩法直接塌掉。
    upkeep: 0.5,
    buildCost: 15,
    footprint: 1,
  },
];

/**
 * 经济参数。
 *
 * 调参目标（一局约 10 分钟，1 天 = 500ms）：
 * - 开局 3 住宅 2 农田，人口 8 → 30 约需 1 个月，玩家几十秒内能看到人口涨。
 * - 月末税收 ≈ 30 人 × 8 × 0.15 × 0.95 ≈ 34，维护费 ≈ 3×2 + 2×3 + 0.5 ≈ 12.5，
 *   净 +21/月 —— 攒两块田要 3 个月，不至于一开局就卡死，也不至于无限膨胀。
 * - `incomePerCapita` 从默认 3 提到 8：默认值配 demo 的 upkeep 会每月稳定亏损。
 */
export const DEMO_CONFIG: EconomyConfig = {
  // 72 个格子，留一倍余量给「拆了重建」产生的墓碑
  entityCapacity: 256,
  cityCount: 1,
  seed: 0x7a6b79,
  taxRate: 0.15,
  foodPerCapita: 0.05,
  incomePerCapita: 8,
  daysPerTick: 1,
  daysPerMonth: 30,
  monthsPerYear: 12,
};

/** 开局可用金币（种子建筑之外的部分）。 */
export const INITIAL_TREASURY = 160;

/** 初始人口。给 8 而不是 0：0 人口时满意度被钉在中性值，看不到人口增长这条链路。 */
export const INITIAL_POPULATION = 8;

/** 初始存粮，够 8 人吃 30 天。 */
export const INITIAL_FOOD = 12;

/**
 * 物理侧吸收区上限。
 *
 * 这个数字来自引擎而不是玩法：3D 视图的水流吸收判定按 zone 线性扫描，
 * 超过 8 个之后每帧多出的判定开销在低端机上会挤掉物理预算。
 * 所以它必须在**下指令之前**拦掉，而不是建完再默默不生效。
 */
export const MAX_FARMS = 8;
