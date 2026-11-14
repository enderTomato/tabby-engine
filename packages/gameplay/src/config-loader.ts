/**
 * 配置表热重载。
 *
 * ## 为什么热重载要单独一层，而不是在 `defs.ts` 里写 `import.meta.hot.accept`
 *
 * 三种改表方式都要能生效，而它们的触发路径完全不同：
 *
 * 1. **改 `defs.ts`** —— Vite 的 HMR 会推一条 update，但模块本身已被求值过，
 *    热替换只换模块对象，`CitySimulation` 里已经传进 `Economy` 的那份表不会变。
 * 2. **改 `public/config/table.json`** —— 不在模块图里，HMR 完全不知道它变了，
 *    只能靠轮询或手动重载。
 * 3. **运行时手动重载**（调试面板 / 控制台）—— 什么都没改，就是想重新读一遍。
 *
 * 所以这里的职责是：**统一成一条 `reload()` 路径**，外部只管调用；
 * 至于「为什么调用」是 HMR 还是按钮，本模块不关心。
 *
 * ## 部分失败怎么办
 *
 * 表校验不过时**不替换**当前表，并把错误原文抛给 UI。
 * 反过来（校验不过就用新表）会让一张写错一个字段的表把整个 demo 打崩，
 * 而改表的人还在编辑器里改到一半 —— 热重载最需要的是「改坏了不炸」。
 */

import type { BuildingDef, ResourceDef, EconomyConfig } from '@tabby/economy';
import { BUILTIN_TABLE, formatErrors, validateTable, type ConfigTable, type ConfigError } from './config-table.js';
import { DEMO_BUILDINGS, DEMO_CONFIG, DEMO_RESOURCES } from './defs.js';

/** 覆盖表的默认位置。放在 `public/` 下所以能被 fetch 到，且不参与打包。 */
export const OVERRIDE_URL = 'config/table.json';

export interface ReloadResult {
  readonly ok: boolean;
  /**
   * 表是否真的被替换了。
   *
   * 与 `ok` 分开：`ok` 说的是「这份表能用」，`changed` 说的是「世界要重建」。
   * 混成一个布尔就会出现「点了重读配置、什么都没改、进度却没了」。
   */
  readonly changed: boolean;
  readonly source: 'builtin' | 'override' | 'memory';
  readonly errors: readonly ConfigError[];
  readonly warnings: readonly ConfigError[];
  readonly message: string;
}

type Listener = (table: ConfigTable, result: ReloadResult) => void;

/**
 * 配置表宿主：持有「当前生效的那份表」，并负责在重载时通知订阅方。
 *
 * 订阅方（`CitySimulation`）拿到新表后**必须重建 Economy**：
 * `buildingType` 存的是表下标，表一变，所有已有建筑的含义都可能变。
 * 所以重载是有代价的（丢当前进度），这也是它只在调试时用的原因。
 */
export class ConfigHost {
  private current: ConfigTable = BUILTIN_TABLE;
  private listeners: Listener[] = [];
  private lastResult: ReloadResult = {
    ok: true,
    changed: false,
    source: 'builtin',
    errors: [],
    warnings: [],
    message: '使用内置配置表',
  };
  private reloads = 0;

  get table(): ConfigTable {
    return this.current;
  }

  get result(): ReloadResult {
    return this.lastResult;
  }

  get reloadCount(): number {
    return this.reloads;
  }

  /** 清空订阅（HMR 换模块时用，避免同一次变更重建两次实例）。 */
  resetSubscribers(): void {
    this.listeners = [];
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  /** 直接应用一份已解析的表（调试面板、控制台改内存表时用）。 */
  apply(raw: unknown, source: ReloadResult['source'] = 'memory'): ReloadResult {
    this.reloads += 1;
    const result = this.adopt(raw, source);
    this.lastResult = result;
    if (result.ok && result.changed) {
      for (const listener of this.listeners) listener(this.current, result);
    }
    return result;
  }

  /**
   * 从 `public/config/table.json` 重载。
   *
   * 404 / 网络失败**不算错误**：绝大多数构建里没有这个文件，
   * 那是「没有覆盖表」，应当安静地回退到内置表，而不是每次启动都弹一个红条。
   */
  async reload(url = OVERRIDE_URL): Promise<ReloadResult> {
    this.reloads += 1;
    let raw: unknown;
    try {
      const response = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) {
        const fallback = this.fallback(`没有覆盖表（HTTP ${response.status}），使用内置配置表`);
        this.lastResult = fallback;
        return fallback;
      }
      raw = await response.json();
    } catch (error) {
      const fallback = this.fallback(`读取覆盖表失败：${describe(error)}`);
      this.lastResult = fallback;
      return fallback;
    }

    const result = this.adopt(raw, 'override');
    this.lastResult = result;
    if (result.ok && result.changed) {
      for (const listener of this.listeners) listener(this.current, result);
    }
    return result;
  }

  private adopt(raw: unknown, source: ReloadResult['source']): ReloadResult {
    const parsed = asConfigTable(raw);
    if (parsed === null) {
      return {
        ok: false,
        changed: false,
        source,
        errors: [{ path: '$', message: '顶层结构必须是 { resources: [], buildings: [], config: {} }' }],
        warnings: [],
        message: '覆盖表结构不对，保留当前配置',
      };
    }

    const check = validateTable(parsed);
    if (!check.ok) {
      return {
        ok: false,
        changed: false,
        source,
        errors: check.errors,
        warnings: check.warnings,
        message: `校验未通过（${check.errors.length} 处错误），保留当前配置：\n${formatErrors(check.errors)}`,
      };
    }

    // 表没变就不重建世界。热重载的痛点是「改到一半保存」，
    // 而无变化的重载（点一下按钮、编辑器存了但内容一样）如果也重建，
    // 玩家会莫名其妙丢进度 —— 那是最容易被骂的一种"功能"。
    if (canonical(parsed) === canonical(this.current)) {
      return {
        ok: true,
        changed: false,
        source,
        errors: [],
        warnings: check.warnings,
        message: '配置无变化，未重建世界',
      };
    }

    this.current = parsed;
    return {
      ok: true,
      changed: true,
      source,
      errors: [],
      warnings: check.warnings,
      message:
        check.warnings.length === 0
          ? `配置已生效（${parsed.buildings.length} 建筑 / ${parsed.resources.length} 资源）`
          : `配置已生效，但有 ${check.warnings.length} 条警告：\n${formatErrors(check.warnings)}`,
    };
  }

  private fallback(message: string): ReloadResult {
    this.current = BUILTIN_TABLE;
    return { ok: true, changed: false, source: 'builtin', errors: [], warnings: [], message };
  }
}

/**
 * 宽松地把 `unknown` 收成 `ConfigTable`。
 *
 * 只在**顶层**做结构检查，字段级校验交给 `validateTable`：
 * 两处都做会让「哪个字段报了什么」变成两份可能不一致的答案。
 * 这里只保证后面那段代码不会因为 `raw.buildings.foo` 抛 TypeError。
 */
export function asConfigTable(raw: unknown): ConfigTable | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const box = raw as Record<string, unknown>;
  if (!Array.isArray(box.resources) || !Array.isArray(box.buildings)) return null;
  if (typeof box.config !== 'object' || box.config === null) return null;
  return {
    resources: box.resources as readonly ResourceDef[],
    buildings: box.buildings as readonly BuildingDef[],
    config: { ...DEMO_CONFIG, ...(box.config as Partial<EconomyConfig>) },
  };
}

/** 内置表与「当前 defs.ts」是否一致，用于诊断面板提示「你改的是 defs.ts，热重载管不到旧实例」。 */
export function builtinMatchesCurrent(host: ConfigHost): boolean {
  const table = host.table;
  return table.resources === DEMO_RESOURCES && table.buildings === DEMO_BUILDINGS;
}

/**
 * 全局唯一的配置宿主。
 *
 * 单例而不是「谁需要谁 new 一个」：热重载的通知必须打到**所有**活着的实例上，
 * 多份 host 会让「有些面板生效、有些没生效」，这类问题极难复现。
 */
export const configHost = new ConfigHost();

/**
 * 规范化序列化：键名排序后再拼。
 *
 * 不能直接用 `JSON.stringify` 比较两份表 —— 键的插入顺序不同（内置表是字面量、
 * 覆盖表是 JSON.parse 出来的）会让语义相同的两份表序列化出不同的字符串，
 * 于是「什么都没改」也会触发重建。这是那种「测试能过、真机丢存档」的 bug。
 */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const box = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(box).sort()) out[key] = sortKeys(box[key]);
    return out;
  }
  return value;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
