/**
 * 城市仿真层集成测试。
 *
 * 这一层测的不是「经济内核算得对不对」（那在 packages/economy/tests 里），
 * 而是**接入方式**对不对：投影会不会漂、指令队列会不会漏、读档后几何会不会残影。
 * 这三个问题都不会让经济内核的单元测试变红，但都会让玩家看见鬼。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Cell, GRID_COLS, GRID_ROWS, TILE_COUNT } from '@tabby/gameplay';
import { INITIAL_POPULATION, INITIAL_TREASURY, MAX_FARMS } from '@tabby/gameplay';
import { CitySimulation, COST } from '@tabby/gameplay';

let sim: CitySimulation;

beforeEach(() => {
  sim = new CitySimulation(0);
});

describe('开局状态', () => {
  it('种子建筑全部落位，金库恰好是可用初始值', () => {
    expect(sim.countOf(Cell.House)).toBe(5);
    expect(sim.countOf(Cell.Farm)).toBe(3);
    expect(sim.countOf(Cell.Wall)).toBe(1);
    expect(sim.treasury).toBe(INITIAL_TREASURY);
    expect(sim.economy.getCity(0)?.population).toBe(INITIAL_POPULATION);
  });

  it('投影与实体池一致', () => {
    const check = sim.verifyProjection();
    expect(check.ok, check.detail).toBe(true);
  });

  it('每个非空格子都能反查到实体，空格子一定反查不到', () => {
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      const kind = sim.cells[tile];
      const id = sim.entityAt[tile];
      if (kind === Cell.Empty) {
        expect(id, `格子 ${tile} 类型为空却有实体 ${id}`).toBe(-1);
      } else {
        expect(id, `格子 ${tile} 有建筑却没有实体`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('建造与拆除', () => {
  it('建造扣款、落位、投影同步', () => {
    const before = sim.treasury;
    const spot = findEmpty(sim);
    expect(sim.cellAt(spot.col, spot.row)).toBe(Cell.Empty);

    const result = sim.build(spot.col, spot.row, 'house');
    expect(result.ok, result.message).toBe(true);
    expect(sim.cellAt(spot.col, spot.row)).toBe(Cell.House);
    expect(sim.treasury).toBe(before - COST.house);
    expect(sim.verifyProjection().ok).toBe(true);
  });

  it('金币不足时拒绝，且不留下半成品', () => {
    // 160 - 40 - 40 - 60 = 20，不够再建一块田（60）
    for (const tool of ['house', 'house', 'farm'] as const) {
      const spot = findEmpty(sim);
      expect(sim.build(spot.col, spot.row, tool).ok).toBe(true);
    }
    expect(sim.treasury).toBe(20);

    const spot = findEmpty(sim);
    const result = sim.build(spot.col, spot.row, 'farm');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('金币不足');
    expect(sim.cellAt(spot.col, spot.row)).toBe(Cell.Empty);
    expect(sim.verifyProjection().ok).toBe(true);
  });

  it('重复建造被拒，第二次不扣钱', () => {
    const spot = findEmpty(sim);
    expect(sim.build(spot.col, spot.row, 'wall').ok).toBe(true);
    const after = sim.treasury;
    const again = sim.build(spot.col, spot.row, 'farm');
    expect(again.ok).toBe(false);
    expect(sim.treasury).toBe(after);
  });

  it('拆除返还一半造价，格子回到空', () => {
    const spot = findEmpty(sim);
    sim.build(spot.col, spot.row, 'house');
    const built = sim.treasury;
    const removed = sim.build(spot.col, spot.row, 'remove');
    expect(removed.ok, removed.message).toBe(true);
    expect(sim.cellAt(spot.col, spot.row)).toBe(Cell.Empty);
    expect(sim.treasury).toBe(built + Math.floor(COST.house / 2));
    expect(sim.verifyProjection().ok).toBe(true);
  });

  it('拆空地、拆越界都不会改状态', () => {
    const before = sim.treasury;
    expect(sim.build(11, 5, 'remove').ok).toBe(false);
    expect(sim.build(-1, 0, 'remove').ok).toBe(false);
    expect(sim.build(GRID_COLS, 0, 'remove').ok).toBe(false);
    expect(sim.build(0, GRID_ROWS, 'remove').ok).toBe(false);
    expect(sim.treasury).toBe(before);
    expect(sim.verifyProjection().ok).toBe(true);
  });

  it('农田数量达到上限后拒绝', () => {
    // 先攒够钱：反复拆建会亏一半，这里直接走存款指令补足
    sim.economy.applyCommand({ type: 'deposit', city: 0, amount: 5000 });

    let placed = 0;
    for (let tile = 0; tile < TILE_COUNT && sim.countOf(Cell.Farm) < MAX_FARMS; tile += 1) {
      if (sim.cells[tile] !== Cell.Empty) continue;
      if (sim.build(tile % GRID_COLS, Math.floor(tile / GRID_COLS), 'farm').ok) placed += 1;
    }
    expect(sim.countOf(Cell.Farm)).toBe(MAX_FARMS);
    expect(placed).toBe(MAX_FARMS - 3);

    const spot = findEmpty(sim);
    const over = sim.build(spot.col, spot.row, 'farm');
    expect(over.ok).toBe(false);
    expect(over.message).toContain(String(MAX_FARMS));
  });
});

describe('长期运行', () => {
  it('跑 3 年：金库不越界、人口不超住房、投影不漂', () => {
    sim.setSpeed(4);
    // x4 速度 = 500ms/天；3 年 = 1080 天
    for (let i = 0; i < 1080; i += 1) sim.advance(500);

    const city = sim.economy.getCity(0);
    expect(city).not.toBeNull();
    if (city === null) return;

    expect(sim.treasury).toBeGreaterThanOrEqual(0);
    expect(sim.treasury).toBeLessThanOrEqual(2_000_000_000);
    expect(city.population).toBeGreaterThan(INITIAL_POPULATION);
    expect(city.population).toBeLessThanOrEqual(city.housing + 1e-3);
    expect(Number.isFinite(city.satisfaction)).toBe(true);
    expect(sim.verifyProjection().ok).toBe(true);
  });

  it('人口在小规模下也会增长（防 round 锁死回归）', () => {
    // 8 人时日增量只有 0.29，一旦内核把人口取整，这里会永远停在 8
    sim.setSpeed(4);
    for (let i = 0; i < 30; i += 1) sim.advance(500);
    const city = sim.economy.getCity(0);
    expect(city?.population ?? 0).toBeGreaterThan(INITIAL_POPULATION);
  });

  it('拆掉全部农田后进入饥荒，人口不反弹', () => {
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      if (sim.cells[tile] !== Cell.Farm) continue;
      sim.build(tile % GRID_COLS, Math.floor(tile / GRID_COLS), 'remove');
    }
    expect(sim.countOf(Cell.Farm)).toBe(0);

    sim.setSpeed(4);
    for (let i = 0; i < 400; i += 1) sim.advance(500);

    const city = sim.economy.getCity(0);
    expect(city?.starving).toBe(true);
    expect(city?.population ?? 0).toBeLessThanOrEqual(INITIAL_POPULATION);
    expect(city?.population ?? 0).toBeGreaterThanOrEqual(0);
  });
});

describe('灌溉折算', () => {
  // 折算单位是 25 单位水 → 3 金币（见 simulation.ts 的 IRRIGATION_UNIT）
  it('按整单位折算，余数留到下次', () => {
    const before = sim.treasury;
    expect(sim.irrigate(24)).toBe(0);
    expect(sim.treasury).toBe(before);
    // 24 + 1 = 25 → 触发一次
    expect(sim.irrigate(1)).toBe(3);
    expect(sim.treasury).toBe(before + 3);
    // 26 → 一次，余 1
    expect(sim.irrigate(26)).toBe(3);
    // 1 + 24 = 25 → 又一次
    expect(sim.irrigate(24)).toBe(3);
    expect(sim.irrigate(1)).toBe(0);
  });

  it('非正数输入不改变累计', () => {
    expect(sim.irrigate(0)).toBe(0);
    expect(sim.irrigate(-100)).toBe(0);
    expect(sim.irrigate(Number.NaN)).toBe(0);
    expect(sim.waterIncome).toBe(0);
  });
});

describe('存档往返', () => {
  it('存档再读档，投影、金库与人口都还原', () => {
    const spot = findEmpty(sim);
    sim.build(spot.col, spot.row, 'wall');
    sim.advance(800);

    const bytes = sim.economy.save();
    const savedTreasury = sim.treasury;
    const savedCells = Int8Array.from(sim.cells);
    const savedPopulation = sim.economy.getCity(0)?.population;

    // 改乱现状
    sim.build(spot.col, spot.row, 'remove');
    sim.build(1, 1, 'remove');
    expect(sim.treasury).not.toBe(savedTreasury);

    sim.economy.load(bytes);
    sim.rebuild();

    expect(sim.treasury).toBe(savedTreasury);
    expect(sim.economy.getCity(0)?.population).toBe(savedPopulation);
    expect(Array.from(sim.cells)).toEqual(Array.from(savedCells));
    expect(sim.verifyProjection().ok).toBe(true);
  });
});

function findEmpty(target: CitySimulation): { col: number; row: number } {
  // 从下往上找：row 小的在画面下方，视觉上不挡已有建筑
  for (let row = GRID_ROWS - 1; row >= 0; row -= 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      if (target.cellAt(col, row) === Cell.Empty) return { col, row };
    }
  }
  throw new Error('网格已满');
}
