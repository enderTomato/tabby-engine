import type { ResourceDef } from './types.js';

/**
 * 单步价格更新。
 *
 * 公式（与 docs/design/T15-economy.md §6 一致）：
 *
 * ```
 * ratio    = clamp(supply / max(demand, ε), 0.25, 4.0)
 * rawPrice = basePrice × (1 / ratio)^elasticity
 * price    = lerp(current, rawPrice, smoothing)
 * price    = clamp(price, basePrice × 0.3, basePrice × 3.0)
 * ```
 *
 * 三处钳制都不是保守，是必需的：
 *
 * - `ratio` 下限：供给趋零时 `1/ratio` 趋向无穷，价格会在一两天内炸到 1e6，
 *   然后玩家的税收按价格算，直接变成无限金币。钳到 0.25 意味着「缺货最多涨 4^elasticity 倍」。
 * - `ratio` 上限：仓库堆满时价格不能归零 —— 归零会让所有生产建筑收益为 0，
 *   整条产业链一夜之间停摆，玩家根本不知道发生了什么。
 * - 最终价格上下界：即使前面都钳住了，连续多月的平滑也会把价格推出合理区间。
 *   这一层是最后一道保险，代价是极端行情下价格「不再上涨」，可以接受。
 */
export const MIN_RATIO = 0.25;
export const MAX_RATIO = 4;
export const MIN_PRICE_FACTOR = 0.3;
export const MAX_PRICE_FACTOR = 3;
const EPSILON = 1e-4;

export function nextPrice(
  current: number,
  supply: number,
  demand: number,
  def: ResourceDef,
  smoothing: number,
): number {
  const safeDemand = Math.max(demand, EPSILON);
  const rawRatio = supply / safeDemand;
  const ratio = clamp(rawRatio, MIN_RATIO, MAX_RATIO);
  const raw = def.basePrice * Math.pow(1 / ratio, def.elasticity);
  const eased = current + (raw - current) * smoothing;
  return clamp(eased, def.basePrice * MIN_PRICE_FACTOR, def.basePrice * MAX_PRICE_FACTOR);
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 通胀检查：货币总量 / 商品总价值。
 *
 * 只上报不自动改玩家设置 —— 自动调税率会让玩家觉得「游戏在偷偷作弊」，
 * 而且会掩盖真正的数值问题（比如某个配方产出写多了一个零）。
 */
export function inflationRatio(moneySupply: number, gdp: number): number {
  if (!(gdp > 0)) return moneySupply > 0 ? Number.POSITIVE_INFINITY : 1;
  return moneySupply / gdp;
}
