/**
 * 配置表校验测试。
 *
 * 校验器的价值全在「能否报出具体哪一行错了」，所以这里几乎每个用例都是
 * **故意改坏一个字段**，然后断言错误落在正确的 path 上。
 * 只断言 `ok === false` 的测试没有意义 —— 它无法阻止把 path 写错。
 */

import { describe, expect, it } from 'vitest';
import type { BuildingDef, ResourceDef } from '@tabby/economy';
import {
  BUILTIN_TABLE,
  formatErrors,
  validateTable,
  type ConfigTable,
} from '@tabby/gameplay';
import { ConfigHost, asConfigTable } from '@tabby/gameplay';
import { DEMO_BUILDINGS, DEMO_CONFIG, DEMO_RESOURCES } from '@tabby/gameplay';

function clone(): ConfigTable {
  return {
    resources: DEMO_RESOURCES.map((res) => ({ ...res })),
    buildings: DEMO_BUILDINGS.map((def) => ({ ...def, input: [...def.input], output: [...def.output] })),
    config: { ...DEMO_CONFIG },
  };
}

function paths(errors: readonly { path: string }[]): string[] {
  return errors.map((item) => item.path);
}

describe('内置表自检', () => {
  it('内置配置表本身必须通过校验', () => {
    const result = validateTable(BUILTIN_TABLE);
    expect(result.errors, formatErrors(result.errors)).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('资源校验', () => {
  it('重复 key 会报错', () => {
    const table = clone();
    // demo 只有一种资源，所以自己追加一个同 key 的副本
    (table as unknown as { resources: ResourceDef[] }).resources = [
      ...table.resources,
      { ...(table.resources[0] as ResourceDef) },
    ];
    const result = validateTable(table);
    expect(result.ok).toBe(false);
    expect(paths(result.errors)).toContain('resources[1].key');
  });

  it('非法 key 格式会报错', () => {
    const table = clone();
    (table.resources[0] as { key: string }).key = 'Food-1';
    const result = validateTable(table);
    expect(paths(result.errors)).toContain('resources[0].key');
  });

  it('非正价格、越界弹性、负目标库存都会被拦住', () => {
    const table = clone();
    (table.resources[0] as { basePrice: number }).basePrice = 0;
    (table.resources[0] as { elasticity: number }).elasticity = 2.5;
    (table.resources[0] as { targetStock: number }).targetStock = -1;
    const result = validateTable(table);
    expect(paths(result.errors)).toContain('resources[0].basePrice');
    expect(paths(result.errors)).toContain('resources[0].elasticity');
    expect(paths(result.errors)).toContain('resources[0].targetStock');
  });

  it('NaN / Infinity 被当成非法而不是「差不多」', () => {
    const table = clone();
    (table.resources[0] as { basePrice: number }).basePrice = NaN;
    (table.resources[0] as { elasticity: number }).elasticity = Infinity;
    const result = validateTable(table);
    expect(result.ok).toBe(false);
    expect(paths(result.errors)).toContain('resources[0].basePrice');
    expect(paths(result.errors)).toContain('resources[0].elasticity');
  });

  it('没有任何建筑产出的资源只给警告，不阻断', () => {
    const table = clone();
    table.buildings.forEach((def) => {
      const box = def as { output: BuildingDef['output'] };
      box.output = [];
    });
    const result = validateTable(table);
    expect(result.ok).toBe(true);
    expect(paths(result.warnings)).toContain('resources[0]');
  });
});

describe('建筑校验', () => {
  it('拼错 category 会报错并列出允许值', () => {
    const table = clone();
    (table.buildings[1] as { category: string }).category = 'prodution';
    const result = validateTable(table);
    const error = result.errors.find((item) => item.path === 'buildings[1].category');
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/housing/);
  });

  it('输出与输入引用同一资源会报错', () => {
    const table = clone();
    const farm = table.buildings[1] as { input: BuildingDef['input'] };
    farm.input = [[0, 1]];
    const result = validateTable(table);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.path.startsWith('buildings[1].output'))).toBe(true);
  });

  it('重复输入资源会报错', () => {
    const table = clone();
    const farm = table.buildings[1] as { input: BuildingDef['input'] };
    farm.input = [[0, 1], [0, 2]];
    const result = validateTable(table);
    expect(paths(result.errors)).toContain('buildings[1].input[1][0]');
  });

  it('不存在的资源下标会报错', () => {
    const table = clone();
    const farm = table.buildings[1] as { output: BuildingDef['output'] };
    farm.output = [[9, 1] as unknown as BuildingDef['output'][number]];
    const result = validateTable(table);
    expect(paths(result.errors)).toContain('buildings[1].output[0][0]');
  });

  it('产出量为 0 或负数会报错（等于这栋建筑不存在）', () => {
    const table = clone();
    const farm = table.buildings[1] as { output: BuildingDef['output'] };
    farm.output = [[0, 0]];
    const result = validateTable(table);
    expect(paths(result.errors)).toContain('buildings[1].output[0][1]');
  });

  it('住宅容量为 0 会报错，非住宅容量为 0 不报', () => {
    const table = clone();
    (table.buildings[0] as { capacity: number }).capacity = 0;
    expect(paths(validateTable(table).errors)).toContain('buildings[0].capacity');
  });

  it('重复建筑 key、负维护费、负造价、非整数占地都会被拦住', () => {
    const table = clone();
    const def = table.buildings[2] as { key: string; upkeep: number; buildCost: number; footprint: number };
    def.key = (table.buildings[0] as BuildingDef).key;
    def.upkeep = -1;
    def.buildCost = -5;
    def.footprint = 0;
    const result = validateTable(table);
    expect(paths(result.errors)).toEqual(
      expect.arrayContaining(['buildings[2].key', 'buildings[2].upkeep', 'buildings[2].buildCost', 'buildings[2].footprint']),
    );
  });
});

describe('全局参数校验', () => {
  it('税率越界、每月天数异常、城市数为 0 都会报错', () => {
    const table = clone();
    (table.config as { taxRate: number }).taxRate = 0.9;
    (table.config as { daysPerMonth: number }).daysPerMonth = 0;
    (table.config as { cityCount: number }).cityCount = 0;
    const result = validateTable(table);
    expect(paths(result.errors)).toEqual(
      expect.arrayContaining(['config.taxRate', 'config.daysPerMonth', 'config.cityCount']),
    );
  });
});

describe('热重载宿主', () => {
  it('校验通过才替换，且会通知订阅方', () => {
    const host = new ConfigHost();
    const seen: ConfigTable[] = [];
    host.subscribe((table) => seen.push(table));

    const good = clone();
    (good.resources[0] as { basePrice: number }).basePrice = 6;
    const ok = host.apply(good);
    expect(ok.ok).toBe(true);
    expect(ok.changed).toBe(true);
    expect(seen.length).toBe(1);
    expect(host.table.resources[0]!.basePrice).toBe(6);
  });

  it('校验失败时保留旧表且不通知订阅方', () => {
    const host = new ConfigHost();
    const before = host.table;
    const seen: ConfigTable[] = [];
    host.subscribe((table) => seen.push(table));

    const bad = clone();
    (bad.resources[0] as { basePrice: number }).basePrice = -1;
    const result = host.apply(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(host.table).toBe(before);
    expect(seen.length).toBe(0);
  });

  it('顶层结构不对时给出 $ 路径的错误', () => {
    const host = new ConfigHost();
    const result = host.apply({ buildings: [] });
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.path).toBe('$');
  });

  it('asConfigTable 只补齐顶层，缺省的 config 字段用内置值兜底', () => {
    const parsed = asConfigTable({
      resources: clone().resources,
      buildings: clone().buildings,
      config: { taxRate: 0.2 },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.config.taxRate).toBe(0.2);
    expect(parsed!.config.daysPerMonth).toBe(DEMO_CONFIG.daysPerMonth);
  });

  it('表没变化时不通知订阅方（避免无意义地重建世界）', () => {
    const host = new ConfigHost();
    const seen: ConfigTable[] = [];
    host.subscribe((table) => seen.push(table));

    // 第一次：与内置表语义相同（demo 的表就是从 defs 抄过来的）
    const first = host.apply(clone());
    expect(first.ok).toBe(true);
    expect(first.changed).toBe(false);
    expect(seen.length).toBe(0);
    expect(first.message).toMatch(/无变化/);

    // 真正改了数值才会触发
    const changed = clone();
    (changed.resources[0] as { basePrice: number }).basePrice = 7;
    host.apply(changed);
    expect(seen.length).toBe(1);
  });

  it('重载计数与最后结果可读（UI 直接显示）', () => {
    const host = new ConfigHost();
    expect(host.reloadCount).toBe(0);
    host.apply(clone());
    expect(host.reloadCount).toBe(1);
    expect(host.result.ok).toBe(true);
    expect(host.result.message).toMatch(/无变化/);

    const changed = clone();
    (changed.resources[0] as { basePrice: number }).basePrice = 9;
    host.apply(changed);
    expect(host.result.changed).toBe(true);
    expect(host.result.message).toMatch(/已生效/);
  });
});
