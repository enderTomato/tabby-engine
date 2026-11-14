/**
 * 配置表校验 —— 把「表写错了」变成启动期的明确报错，而不是运行期的静默偏差。
 *
 * ## 为什么需要它（内核已经校验过了）
 *
 * `@tabby/economy` 的 `validateResources` / `validateBuildings` 只检查**内核能算得下去**
 * 的条件（下标在范围内、成本非负、住房容量 > 0）。它们不知道也不该知道玩法层的约束：
 *
 * - `key` 重复 → 两个建筑共用一个名字，UI 上一个按钮点了建出另一个；
 * - `category` 拼错成 `'prodution'` → `aggregate` 里按 category 分支的统计全部漏掉；
 * - 同一资源同时出现在 `input` 和 `output` → 日产净额恒为 0，玩家永远看不到变化；
 * - `footprint` 大于 1 但 demo 的格子模型是 1 格 1 建筑 → 建上去会吃掉邻居。
 *
 * 这些都不会让内核崩，只会让数值悄悄不对。所以这一层是**玩法约束的守卫**，
 * 与内核的校验互补，而不是替代。
 *
 * ## 校验结果为什么带 path
 *
 * 「配置有 3 处错误」没法修，「buildings[2].category 期望 production|housing|infrastructure，
 * 实际 'prodution'」能直接改。所有错误都带 JSON 路径，直接显示在诊断面板里。
 */

import type { BuildingDef, EconomyConfig, ResourceDef } from '@tabby/economy';
import { DEMO_BUILDINGS, DEMO_CONFIG, DEMO_RESOURCES } from './defs';

export interface ConfigError {
  /** JSON 路径，例如 `buildings[2].category`。 */
  readonly path: string;
  readonly message: string;
}

export interface ConfigTable {
  readonly resources: readonly ResourceDef[];
  readonly buildings: readonly BuildingDef[];
  readonly config: EconomyConfig;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly ConfigError[];
  readonly warnings: readonly ConfigError[];
}

/** 与经济内核的 `BuildingCategory` 逐字对齐。内核加分类时这里会编译报错（见下方断言）。 */
const CATEGORY_LIST = ['housing', 'production', 'infrastructure'] as const;
const CATEGORIES = new Set<string>(CATEGORY_LIST);
/** 编译期护栏：内核的分类联合与这里的字面量集合必须完全一致。 */
type CategoryGuard = (typeof CATEGORY_LIST)[number] extends BuildingDef['category']
  ? BuildingDef['category'] extends (typeof CATEGORY_LIST)[number]
    ? true
    : never
  : never;
const _categoryGuard: CategoryGuard = true;
void _categoryGuard;

/** 资源 key 的白名单是开放的（玩法可以自定义），但格式要固定：小写字母/数字/下划线。 */
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegative(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function checkKey(value: unknown, path: string, errors: ConfigError[]): void {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    errors.push({ path, message: `必须是 ${KEY_PATTERN} 形式的小写标识符，实际 ${JSON.stringify(value)}` });
  }
}

export function validateTable(table: ConfigTable): ValidationResult {
  const errors: ConfigError[] = [];
  const warnings: ConfigError[] = [];

  // ---- 资源 ----
  const resourceKeys = new Set<string>();
  table.resources.forEach((res, i) => {
    const at = `resources[${i}]`;
    checkKey(res.key, `${at}.key`, errors);
    if (resourceKeys.has(res.key)) errors.push({ path: `${at}.key`, message: `重复的资源 key「${res.key}」` });
    resourceKeys.add(res.key);

    if (typeof res.label !== 'string' || res.label.length === 0) {
      errors.push({ path: `${at}.label`, message: '资源必须有显示名' });
    }
    if (!(isFiniteNumber(res.basePrice) && res.basePrice > 0)) {
      errors.push({ path: `${at}.basePrice`, message: `基础价格必须 > 0，实际 ${res.basePrice}` });
    }
    if (!(isFiniteNumber(res.elasticity) && res.elasticity > 0 && res.elasticity <= 2)) {
      errors.push({ path: `${at}.elasticity`, message: `弹性必须在 (0, 2]，实际 ${res.elasticity}` });
    }
    if (!isNonNegative(res.targetStock)) {
      errors.push({ path: `${at}.targetStock`, message: `目标库存不能为负，实际 ${res.targetStock}` });
    }
    if (isFiniteNumber(res.basePrice) && res.basePrice < 0.5) {
      warnings.push({ path: `${at}.basePrice`, message: `价格 ${res.basePrice} 太低，市场结算会出现「1 单位买不到东西」的取整问题` });
    }
  });

  if (table.resources.length === 0) errors.push({ path: 'resources', message: '资源表不能为空' });
  if (table.resources.length > 4) {
    errors.push({ path: 'resources', message: `demo 只支持 4 种资源（RES_STRIDE 限制），实际 ${table.resources.length}` });
  }

  // ---- 建筑 ----
  const buildingKeys = new Set<string>();
  const producerOutputs = new Map<number, number>();
  table.buildings.forEach((def, i) => {
    const at = `buildings[${i}]`;
    checkKey(def.key, `${at}.key`, errors);
    if (buildingKeys.has(def.key)) errors.push({ path: `${at}.key`, message: `重复的建筑 key「${def.key}」` });
    buildingKeys.add(def.key);

    if (typeof def.label !== 'string' || def.label.length === 0) {
      errors.push({ path: `${at}.label`, message: '建筑必须有显示名' });
    }
    if (!CATEGORIES.has(def.category)) {
      errors.push({
        path: `${at}.category`,
        message: `未知分类「${def.category}」，允许：${Array.from(CATEGORIES).sort().join(' / ')}`,
      });
    }
    if (!Number.isInteger(def.footprint) || def.footprint < 1) {
      errors.push({ path: `${at}.footprint`, message: `占地必须是 ≥1 的整数，实际 ${def.footprint}` });
    }
    if (def.footprint !== 1) {
      warnings.push({ path: `${at}.footprint`, message: `demo 的放置逻辑按 1 格 1 建筑实现，footprint=${def.footprint} 只影响占地检查` });
    }
    if (!isNonNegative(def.buildCost)) {
      errors.push({ path: `${at}.buildCost`, message: `造价不能为负，实际 ${def.buildCost}` });
    }
    if (!isNonNegative(def.upkeep)) {
      errors.push({ path: `${at}.upkeep`, message: `维护费不能为负，实际 ${def.upkeep}` });
    }
    if (!isNonNegative(def.jobs)) {
      errors.push({ path: `${at}.jobs`, message: `岗位数不能为负，实际 ${def.jobs}` });
    }
    if (def.category === 'housing' && !(isFiniteNumber(def.capacity) && def.capacity > 0)) {
      errors.push({ path: `${at}.capacity`, message: `住宅的容量必须 > 0，实际 ${def.capacity}` });
    }

    const seenIn = new Set<number>();
    def.input.forEach((pair, k) => {
      const p = `${at}.input[${k}]`;
      const [res, amount] = pair;
      if (!Number.isInteger(res) || res < 0 || res >= table.resources.length) {
        errors.push({ path: `${p}[0]`, message: `引用了不存在的资源下标 ${res}（共 ${table.resources.length} 种）` });
      }
      if (seenIn.has(res)) errors.push({ path: `${p}[0]`, message: `同一输入资源重复声明（下标 ${res}）` });
      seenIn.add(res);
      if (!(isFiniteNumber(amount) && amount >= 0)) {
        errors.push({ path: `${p}[1]`, message: `输入量必须是非负有限数，实际 ${amount}` });
      }
    });

    const seenOut = new Set<number>();
    def.output.forEach((pair, k) => {
      const p = `${at}.output[${k}]`;
      const [res, amount] = pair;
      if (!Number.isInteger(res) || res < 0 || res >= table.resources.length) {
        errors.push({ path: `${p}[0]`, message: `引用了不存在的资源下标 ${res}（共 ${table.resources.length} 种）` });
      }
      if (seenIn.has(res)) {
        errors.push({ path: `${p}[0]`, message: `资源「${table.resources[res]?.key ?? res}」同时是输入和产出，日净额恒为 0` });
      }
      if (seenOut.has(res)) errors.push({ path: `${p}[0]`, message: `同一产出资源重复声明（下标 ${res}）` });
      seenOut.add(res);
      if (!(isFiniteNumber(amount) && amount > 0)) {
        errors.push({ path: `${p}[1]`, message: `产出量必须 > 0，实际 ${amount}` });
      }
      if (isFiniteNumber(amount)) producerOutputs.set(res, (producerOutputs.get(res) ?? 0) + amount);
    });
  });

  if (table.buildings.length === 0) errors.push({ path: 'buildings', message: '建筑表不能为空' });

  // 没有任何建筑产出的资源是死资源：价格会一路跌到底，HUD 上显示一个永远为 0 的库存
  for (let res = 0; res < table.resources.length; res += 1) {
    if ((producerOutputs.get(res) ?? 0) <= 0) {
      warnings.push({
        path: `resources[${res}]`,
        message: `资源「${table.resources[res]?.key}」没有任何建筑产出，市场只会消耗它`,
      });
    }
  }

  // ---- 全局参数 ----
  const cfg = table.config;
  if (!Number.isInteger(cfg.entityCapacity) || cfg.entityCapacity < 1) {
    errors.push({ path: 'config.entityCapacity', message: `实体池容量必须是正整数，实际 ${cfg.entityCapacity}` });
  }
  if (!Number.isInteger(cfg.cityCount) || cfg.cityCount < 1) {
    errors.push({ path: 'config.cityCount', message: `城市数必须是正整数，实际 ${cfg.cityCount}` });
  }
  if (!(isFiniteNumber(cfg.taxRate) && cfg.taxRate >= 0 && cfg.taxRate <= 0.6)) {
    errors.push({ path: 'config.taxRate', message: `税率必须在 [0, 0.6]，实际 ${cfg.taxRate}` });
  }
  if (!(isFiniteNumber(cfg.foodPerCapita) && cfg.foodPerCapita > 0)) {
    errors.push({ path: 'config.foodPerCapita', message: `人均口粮必须 > 0，实际 ${cfg.foodPerCapita}` });
  }
  if (!Number.isInteger(cfg.daysPerMonth) || cfg.daysPerMonth < 1 || cfg.daysPerMonth > 90) {
    errors.push({ path: 'config.daysPerMonth', message: `每月天数必须在 1..90，实际 ${cfg.daysPerMonth}` });
  }
  if (!Number.isInteger(cfg.monthsPerYear) || cfg.monthsPerYear < 1 || cfg.monthsPerYear > 24) {
    errors.push({ path: 'config.monthsPerYear', message: `每年月数必须在 1..24，实际 ${cfg.monthsPerYear}` });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 内置配置表。热重载失败时回退到它 —— 永远有一份能跑的表。 */
export const BUILTIN_TABLE: ConfigTable = {
  resources: DEMO_RESOURCES,
  buildings: DEMO_BUILDINGS,
  config: DEMO_CONFIG,
};

export function formatErrors(list: readonly ConfigError[], limit = 8): string {
  if (list.length === 0) return '无';
  const shown = list.slice(0, limit).map((item) => `· ${item.path}: ${item.message}`);
  if (list.length > limit) shown.push(`· …还有 ${list.length - limit} 条`);
  return shown.join('\n');
}
