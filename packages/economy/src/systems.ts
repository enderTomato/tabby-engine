import type { BuildingDef, EconomyConfig, LogisticsProvider, ResourceDef } from './types.js';
import { RES_STRIDE } from './types.js';
import type { EconomyState } from './state.js';
import { clamp, inflationRatio, nextPrice } from './price.js';
import { TREASURY_MAX, TREASURY_MIN } from './types.js';

export interface SystemContext {
  readonly state: EconomyState;
  readonly buildings: readonly BuildingDef[];
  readonly resources: readonly ResourceDef[];
  readonly config: EconomyConfig;
  /** 物流接口，null 表示无物流系统。 */
  readonly logistics: LogisticsProvider | null;
  /**
   * 物流统计输出（长度 cityCount × 2，[受阻数, 总数] 交错）。
   * 由 Economy 持有并复用，避免每 tick 分配数组。
   */
  readonly logisticsStats: Int32Array;
}

/**
 * 系统执行顺序（写死，不提供配置项）。
 *
 * ```
 * 0. aggregate   派生统计（住房/岗位），只读
 * 1. production  生产
 * 2. consumption 消耗
 * 3. logistics   运输（统计受阻建筑并发事件；效率修正由 production 读取）
 * 4. market      价格
 * 5. population  人口迁移
 * 6. tax         税收（月末）
 * 7. maintenance 维护费（月末）
 * 8. events      阈值事件
 * ```
 *
 * 顺序即语义，改动等于改玩法：
 *
 * - 生产在消费前：本日产出参与本日消耗，否则永远差一天，前期体验是「田建好了还是饿死」。
 * - 市场在物流后：价格应反映实际到货，不是计划产量。
 * - 税收在人口后：用当日人口算税。
 * - 维护费最后：它依赖前面全部结果（金库、效率）。
 *
 * 月结（tax / maintenance）也走同一条链路，靠内部判断「今天是不是月末」触发，
 * 而不是另起一条月度流水线 —— 两条链路迟早会有人漏改其中一条。
 */

/** 步骤 0：把建筑聚合到城市。只读建筑、只写派生数组，不产生任何经济后果。 */
export function aggregate(ctx: SystemContext): void {
  const { state } = ctx;
  state.cityHousing.fill(0);
  state.cityJobs.fill(0);

  for (let id = 0; id < state.capacity; id += 1) {
    if (state.alive[id] === 0) continue;
    const city = state.buildingCity[id] as number;
    if (city < 0 || city >= state.cityCount) continue;
    const def = ctx.buildings[state.buildingType[id] as number];
    if (def === undefined) continue;
    if (def.capacity > 0) state.cityHousing[city] = (state.cityHousing[city] as number) + def.capacity;
    if (def.jobs > 0) state.cityJobs[city] = (state.cityJobs[city] as number) + def.jobs;
  }

  for (let city = 0; city < state.cityCount; city += 1) {
    const pop = state.cityPopulation[city] as number;
    const jobs = state.cityJobs[city] as number;
    state.cityEmployed[city] = Math.min(pop, jobs);
    // 无人居住的城市别拖着 0 人口的满意度计算，直接钉到中性值
    if (pop <= 0) state.citySatisfaction[city] = 0.5;
  }
}

/** 步骤 1：生产。输入不足按可满足比例缩产，不是「有就满产、没有就停产」。 */
export function runProduction(ctx: SystemContext): void {
  const { state } = ctx;
  const stride = RES_STRIDE;

  for (let id = 0; id < state.capacity; id += 1) {
    if (state.alive[id] === 0) continue;
    const def = ctx.buildings[state.buildingType[id] as number];
    if (def === undefined || def.output.length === 0) continue;
    const city = state.buildingCity[id] as number;
    if (city < 0) continue;

    let scale = state.buildingEfficiency[id] as number;
    // 物流因子在这里乘而不是写回 buildingEfficiency：
    // efficiency 是「维护费支付比例」的累积状态（月末才变），
    // 物流是每 tick 都可能变的瞬时状态。混在一起写会让两者互相覆盖，
    // 症状是「交齐了维护费但建筑还是半停产」或者反之。
    if (ctx.logistics !== null) {
      const factor = sanitizeEfficiency(ctx.logistics.efficiencyOf(id, city));
      state.scratchLogistics[id] = factor;
      scale *= factor;
    }
    if (scale <= 0.01) continue;

    for (let k = 0; k < def.input.length; k += 1) {
      const [res, amount] = def.input[k] as readonly [number, number];
      if (amount <= 0) continue;
      const have = state.cityStock[city * stride + res] as number;
      if (have < amount) scale = Math.min(scale, have / amount);
    }
    if (scale <= 0.01) continue;

    for (let k = 0; k < def.input.length; k += 1) {
      const [res, amount] = def.input[k] as readonly [number, number];
      if (amount <= 0) continue;
      const at = city * stride + res;
      const taken = amount * scale;
      state.cityStock[at] = Math.max(0, (state.cityStock[at] as number) - taken);
      state.scratchConsumed[at] = (state.scratchConsumed[at] as number) + taken;
    }

    for (let k = 0; k < def.output.length; k += 1) {
      const [res, amount] = def.output[k] as readonly [number, number];
      const at = city * stride + res;
      const made = amount * scale;
      state.cityStock[at] = (state.cityStock[at] as number) + made;
      state.scratchProduced[at] = (state.scratchProduced[at] as number) + made;
    }
  }
}

/** 步骤 2：人口吃粮。缺口比例写进 cityFoodShortage，供满意度与事件读取。 */
export function runConsumption(ctx: SystemContext): void {
  const { state, config } = ctx;
  const stride = RES_STRIDE;
  const food = 0;

  for (let city = 0; city < state.cityCount; city += 1) {
    const pop = state.cityPopulation[city] as number;
    if (pop <= 0) {
      state.cityFoodShortage[city] = 0;
      continue;
    }
    const demand = pop * config.foodPerCapita;
    const at = city * stride + food;
    const have = state.cityStock[at] as number;
    const eaten = Math.min(have, demand);
    state.cityStock[at] = Math.max(0, have - eaten);
    state.scratchConsumed[at] = (state.scratchConsumed[at] as number) + eaten;
    state.cityFoodShortage[city] = demand > 0 ? clamp(1 - eaten / demand, 0, 1) : 0;
  }
}

/**
 * 步骤 3：运输。
 *
 * 职责边界值得说清楚：**效率修正不在这里做**，而是在 `runProduction` 里现查。
 * 因为效率是「本 tick 的即时状态」，写回 `buildingEfficiency` 会和维护费的
 * 累积逻辑打架（维护费是月末按支付比例逐步下调）。
 *
 * 这一步只做「发现异常并上报」：统计每个城市里完全受阻的建筑数量，
 * 超过阈值时发 `logistics-blocked` 事件，让 UI 能弹出「补给线断了」。
 *
 * 为什么不是每 tick 都发：一个城市 50 个建筑全断，60Hz 下就是 3000 次/秒的事件。
 * 这里用「每天每个城市最多一次」的节流，与 famine/bankrupt 这些事件同级。
 */
export function runLogistics(ctx: SystemContext): void {
  const provider = ctx.logistics;
  if (provider === null) return;

  const { state } = ctx;
  for (let city = 0; city < state.cityCount; city += 1) {
    let total = 0;
    let blocked = 0;
    for (let id = 0; id < state.capacity; id += 1) {
      if (state.alive[id] === 0) continue;
      if ((state.buildingCity[id] as number) !== city) continue;
      const def = ctx.buildings[state.buildingType[id] as number];
      // 只统计有产出的建筑：住宅不参与物流，把它们算进来会让阈值失去意义
      if (def === undefined || def.output.length === 0) continue;
      total += 1;
      // 读 runProduction 写下的结果，不重新问 provider ——
      // 否则同一天的生产系数与统计口径可能来自两次不同的查询。
      if ((state.scratchLogistics[id] as number) <= 0.01) blocked += 1;
    }
    ctx.logisticsStats[city * 2] = blocked;
    ctx.logisticsStats[city * 2 + 1] = total;
  }
}

/**
 * 把 provider 返回值收敛到 [0, 1]。
 *
 * `NaN` 必须单独挡：`NaN` 参与所有比较都是 false，
 * 于是 `scale *= NaN` 之后 `if (scale <= 0.01)` 也不成立，产出会变成 NaN 并污染库存，
 * 而 Float32Array 里 NaN 一旦写进去，往后所有月份的金库/价格都是 NaN，
 * 存档再一读就永久坏掉。这类 bug 只在第三方 provider 写错时出现，但代价是整档报废。
 */
function sanitizeEfficiency(value: number): number {
  if (!(value > 0)) return 0;
  if (value > 1) return 1;
  return value;
}

/** 步骤 4：价格。供给用「期初库存 + 本期产量」，需求用「本期消耗 + 储备缺口」。 */
export function runMarket(ctx: SystemContext): void {
  const { state, resources } = ctx;
  const stride = RES_STRIDE;

  for (let res = 0; res < resources.length; res += 1) {
    const def = resources[res] as ResourceDef;
    // 价格表是全局一张的（多城市共市），所以供给与需求必须跨城市汇总。
    // 曾经写成「每个城市各自更新一次」，结果城市数一变价格灵敏度就跟着变，
    // 平滑系数看起来像在调参，其实是在补偿结构错误。
    let stock = 0;
    let produced = 0;
    let consumed = 0;
    for (let city = 0; city < state.cityCount; city += 1) {
      const at = city * stride + res;
      stock += state.cityStock[at] as number;
      produced += state.scratchProduced[at] as number;
      consumed += state.scratchConsumed[at] as number;
    }

    const supply = Math.max(0, stock + produced);
    const shortfall = Math.max(0, def.targetStock - stock) * state.cityCount;
    const demand = consumed + shortfall;
    const current = state.price[res] as number;
    state.priceTarget[res] = nextPrice(current, supply, demand, def, 0.15);
  }

  // 单一累加器、升序、先算完再写回：不依赖遍历顺序，也不做 SIMD 归约
  for (let res = 0; res < resources.length; res += 1) {
    state.price[res] = state.priceTarget[res] as number;
  }
}

/** 步骤 5：人口迁移。满意度驱动，住房容量钳制。 */
export function runPopulation(ctx: SystemContext): void {
  const { state } = ctx;

  for (let city = 0; city < state.cityCount; city += 1) {
    const pop = state.cityPopulation[city] as number;
    const housing = state.cityHousing[city] as number;
    const jobs = state.cityJobs[city] as number;
    const shortage = state.cityFoodShortage[city] as number;
    const taxRate = state.cityTaxRate[city] as number;

    // 三项权重固定：吃饱 > 有活干 > 税低。缺粮时满意度断崖，避免「饿着还开心」
    const foodScore = 1 - shortage;
    const jobScore = pop > 0 ? Math.min(1, jobs / pop) : 0.5;
    const taxScore = 1 - clamp(taxRate, 0, 0.6) / 0.6;
    let satisfaction = foodScore * 0.5 + jobScore * 0.3 + taxScore * 0.2;
    if (shortage > 0.3) satisfaction *= 0.5;
    satisfaction = clamp(satisfaction, 0, 1);
    state.citySatisfaction[city] = satisfaction;

    // 增长率：满意度 0.5 是持平点，向两侧线性放大。基数用当前人口，
    // 但增量上限按住房剩余算，防止「空房子一夜住满」
    const drift = (satisfaction - 0.5) * 0.08;
    const free = Math.max(0, housing - pop);
    let delta = pop * drift;
    if (delta > 0) delta = Math.min(delta, free);
    /*
     * 这里**不能** round/floor。
     *
     * 曾经写的是 `Math.round(pop + delta)`，理由是「人口应该取整」。
     * 结果是小城市彻底锁死：8 人、满意度 0.95 时 delta = 8 × 0.45 × 0.08 = 0.288，
     * round(8.288) 还是 8 —— 每天白算一次，永远长不大。反过来人口衰减也一样，
     * 8 人的村子断了粮也不掉人。阈值大约在 1 / (0.045 × 0.08) ≈ 15 人，
     * 也就是「新手村永远停在 8 人」这种最难被察觉的形态。
     *
     * 改法：允许小数，只在展示层取整（`CitySnapshot` 的消费方自己 round）。
     * Float32 的加减乘是 IEEE754 精确定义的，跨设备逐位一致，不会破坏确定性；
     * 真正需要担心的是 Math.pow 这类超越函数，这里没有。
     */
    const next = Math.max(0, pop + delta);
    state.cityPopulation[city] = next;

    if (next > 0 && jobs > 0) state.cityEmployed[city] = Math.min(next, jobs);
  }
}

/** 步骤 6：税收（月末）。税率由玩家设置，满意度打折，避税不做（会把模型复杂化但没有玩法收益）。 */
export function runTax(ctx: SystemContext, daysPerMonth: number): { taxIncome: number } {
  const { state, config } = ctx;
  if (state.day !== daysPerMonth) return { taxIncome: 0 };

  let total = 0;
  for (let city = 0; city < state.cityCount; city += 1) {
    const pop = state.cityPopulation[city] as number;
    const rate = state.cityTaxRate[city] as number;
    const satisfaction = state.citySatisfaction[city] as number;
    if (pop <= 0) continue;
    const income = pop * config.incomePerCapita * rate * (0.5 + satisfaction * 0.5);
    const rounded = Math.round(income);
    // 与 Economy.addTreasury 同一上下界：这里是唯一绕过门面的写入点
    state.cityTreasury[city] = clamp((state.cityTreasury[city] as number) + rounded, TREASURY_MIN, TREASURY_MAX);
    total += rounded;
  }
  return { taxIncome: total };
}

/** 步骤 7：维护费（月末）。付不起就按比例欠，效率随之下滑。 */
export function runMaintenance(ctx: SystemContext, daysPerMonth: number): { upkeep: number } {
  const { state } = ctx;
  if (state.day !== daysPerMonth) return { upkeep: 0 };

  let totalUpkeep = 0;
  for (let city = 0; city < state.cityCount; city += 1) {
    let upkeep = 0;
    for (let id = 0; id < state.capacity; id += 1) {
      if (state.alive[id] === 0) continue;
      if ((state.buildingCity[id] as number) !== city) continue;
      const def = ctx.buildings[state.buildingType[id] as number];
      if (def === undefined) continue;
      upkeep += def.upkeep;
    }

    const treasury = state.cityTreasury[city] as number;
    const paid = Math.min(treasury, upkeep);
    state.cityTreasury[city] = treasury - paid;
    const payRatio = upkeep > 0 ? paid / upkeep : 1;
    totalUpkeep += paid;

    // 效率向「实际支付比例」靠拢，每 30 天一步，最多两三个月见底。
    // 不做成一次归零：突然全部停产会让玩家以为游戏坏了，而逐步下滑能传达因果
    for (let id = 0; id < state.capacity; id += 1) {
      if (state.alive[id] === 0) continue;
      if ((state.buildingCity[id] as number) !== city) continue;
      const eff = state.buildingEfficiency[id] as number;
      state.buildingEfficiency[id] = eff + (payRatio - eff) * 0.5;
    }
  }
  return { upkeep: totalUpkeep };
}

export interface EventOutcome {
  readonly bankruptcies: readonly number[];
  readonly famines: readonly { readonly city: number; readonly ratio: number }[];
  readonly booms: readonly { readonly city: number; readonly population: number }[];
}

/** 步骤 8：阈值事件。只观测、不修改状态 —— 谁想改谁去发指令。 */
export function runEvents(ctx: SystemContext, daysPerMonth: number): EventOutcome {
  const { state } = ctx;
  const bankruptcies: number[] = [];
  const famines: { city: number; ratio: number }[] = [];
  const booms: { city: number; population: number }[] = [];

  if (state.day === daysPerMonth) {
    for (let city = 0; city < state.cityCount; city += 1) {
      if ((state.cityTreasury[city] as number) < 0) bankruptcies.push(city);
    }
  }

  for (let city = 0; city < state.cityCount; city += 1) {
    const shortage = state.cityFoodShortage[city] as number;
    if (shortage > 0.5) famines.push({ city, ratio: shortage });
    const pop = state.cityPopulation[city] as number;
    const housing = state.cityHousing[city] as number;
    if (pop > 0 && housing > 0 && pop >= housing * 0.95 && (state.citySatisfaction[city] as number) > 0.75) {
      booms.push({ city, population: pop });
    }
  }

  return { bankruptcies, famines, booms };
}

export function gdpOf(ctx: SystemContext): number {
  const { state, resources } = ctx;
  const stride = RES_STRIDE;
  let gdp = 0;
  for (let city = 0; city < state.cityCount; city += 1) {
    let cityValue = 0;
    for (let res = 0; res < resources.length; res += 1) {
      const qty = state.cityStock[city * stride + res] as number;
      const price = state.price[res] as number;
      cityValue += qty * price;
    }
    gdp += cityValue;
  }
  return gdp;
}

export function moneySupplyOf(state: EconomyState): number {
  let total = 0;
  for (let city = 0; city < state.cityCount; city += 1) {
    total += state.cityTreasury[city] as number;
  }
  return total;
}

export { inflationRatio };
