/**
 * 路网接入测试。
 *
 * 测的是「接入方式」而不是图算法本身（那在 packages/graph/tests 里）：
 * 挡板会不会真的断路、拆建筑会不会漏解绑、读档会不会留下幽灵墙。
 * 这三类问题都不会让图包的单元测试变红，但都会让玩家看见「明明修好了路，田还是停产」。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Cell, GRID_COLS, GRID_ROWS, TILE_COUNT, indexOf } from '@tabby/gameplay';
import { HUB_TILE, ROAD_FREE_DISTANCE } from '@tabby/gameplay';
import { CitySimulation } from '@tabby/gameplay';

let sim: CitySimulation;

beforeEach(() => {
  sim = new CitySimulation(0);
});

/** 把某一列整列铺上挡板，形成一道横贯的墙。 */
function wallColumn(target: CitySimulation, col: number): void {
  for (let row = 0; row < GRID_ROWS; row += 1) {
    if (target.cellAt(col, row) === Cell.Empty) target.build(col, row, 'wall');
  }
}

describe('路网拓扑', () => {
  it('开局所有地块都在图里，枢纽就在 (0,0)', () => {
    expect(HUB_TILE).toBe(indexOf(0, 0));
    expect(sim.roads.graph.nodeCount).toBe(TILE_COUNT);
    expect(sim.roads.logistics.hubOf(0)).toBe(HUB_TILE);
  });

  it('无挡板时每个地块都有 2~4 个可通行邻居', () => {
    // 清掉开局那块挡板
    const wallTile = Array.from(sim.cells).indexOf(Cell.Wall);
    expect(wallTile).toBeGreaterThanOrEqual(0);
    const col = wallTile % GRID_COLS;
    const row = (wallTile - col) / GRID_COLS;
    sim.build(col, row, 'remove');

    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      expect(sim.roads.openNeighbors(tile)).toBeGreaterThanOrEqual(2);
    }
  });

  it('挡板会挡住邻居，自己也没有可通行邻居', () => {
    const tile = indexOf(5, 3);
    expect(sim.cellAt(5, 3)).toBe(Cell.Empty);
    sim.build(5, 3, 'wall');
    expect(sim.cellAt(5, 3)).toBe(Cell.Wall);
    expect(sim.roads.isWall(tile)).toBe(true);
    expect(sim.roads.openNeighbors(tile)).toBe(0);
    // 左邻居少了右边这条通路
    expect(sim.roads.openNeighbors(indexOf(4, 3))).toBeLessThan(4);
  });

  it('拆掉挡板后通路恢复', () => {
    const before = sim.roads.graph.edgeCount;
    sim.build(6, 4, 'wall');
    const withWall = sim.roads.graph.edgeCount;
    expect(withWall).toBeLessThan(before);

    sim.build(6, 4, 'remove');
    expect(sim.roads.graph.edgeCount).toBe(before);
  });
});

describe('物流效率', () => {
  it('市政厅附近的建筑满效率', () => {
    // 种子房子在 (1,1)，距离枢纽 2 格 < freeDistance
    const tile = indexOf(1, 1);
    const id = sim.entityOfTile(tile);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(sim.roads.logistics.efficiencyOf(id, 0)).toBe(1);
  });

  it('远端建筑效率下降但大于 0', () => {
    // 在右下角放一块田
    const col = GRID_COLS - 1;
    const row = GRID_ROWS - 1;
    expect(sim.cellAt(col, row)).toBe(Cell.Empty);
    const result = sim.build(col, row, 'farm');
    expect(result.ok, result.message).toBe(true);
    const id = sim.entityOfTile(indexOf(col, row));
    const eff = sim.roads.logistics.efficiencyOf(id, 0);
    expect(eff).toBeGreaterThan(0);
    expect(eff).toBeLessThan(1);
  });

  it('用挡板把建筑围死 → 效率归零', () => {
    const col = 4;
    const row = 4;
    expect(sim.cellAt(col, row)).toBe(Cell.Empty);
    const placed = sim.build(col, row, 'farm');
    expect(placed.ok, placed.message).toBe(true);
    const id = sim.entityOfTile(indexOf(col, row));
    expect(sim.roads.logistics.efficiencyOf(id, 0)).toBeGreaterThan(0);

    // 四邻全堵上
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const c = col + dc;
      const r = row + dr;
      if (sim.cellAt(c, r) === Cell.Empty) sim.build(c, r, 'wall');
    }
    expect(sim.roads.logistics.efficiencyOf(id, 0)).toBe(0);
  });

  it('整列挡板会把地图切成两半，远端断供', () => {
    wallColumn(sim, 6);
    // (9,3) 在墙的右侧，只能绕行；绕不过去（上下都被边界挡住）
    expect(sim.roads.logistics.efficiencyOf(sim.entityOfTile(indexOf(8, 1)), 0)).toBe(0);
  });

  it('挡板被拆开后远端恢复通行', () => {
    const col = 6;
    wallColumn(sim, col);
    const id = sim.entityOfTile(indexOf(8, 1));
    expect(sim.roads.logistics.efficiencyOf(id, 0)).toBe(0);

    for (let row = 0; row < GRID_ROWS; row += 1) {
      if (sim.cellAt(col, row) === Cell.Wall) sim.build(col, row, 'remove');
    }
    expect(sim.roads.logistics.efficiencyOf(id, 0)).toBeGreaterThan(0);
  });

  it('效率被经济层真正用上：断供后食物不再增长', () => {
    // 先把三块田全饿死（围死每块田的四邻），再对比产量
    const farmTiles: number[] = [];
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      if (sim.cells[tile] === Cell.Farm) farmTiles.push(tile);
    }
    expect(farmTiles.length).toBeGreaterThan(0);

    sim.economy.tickDays(1);
    const before = sim.economy.state.stockOf(0, 0);

    // 围一圈墙要 100 多金币，开局那点钱不够，先补一笔（测试只关心拓扑，不关心财政）
    sim.economy.applyCommand({ type: 'deposit', city: 0, amount: 500 });
    for (const tile of farmTiles) {
      const col = tile % GRID_COLS;
      const row = (tile - col) / GRID_COLS;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const c = col + dc;
        const r = row + dr;
        if (sim.cellAt(c, r) === Cell.Empty) sim.build(c, r, 'wall');
      }
    }
    // 三块田是连在一起的，所以要围的是整块的周长；墙围好之后必须再跑一天，
    // 因为 logisticsStats 是每个日 tick 才更新的（HUD 读的是这份结果）
    sim.economy.tickDays(1);
    const stats = sim.supply();
    expect(stats.blocked, `应有三块田被围死，实际 ${stats.blocked}/${stats.total}`).toBe(farmTiles.length);
    expect(stats.total).toBe(farmTiles.length);

    sim.economy.tickDays(3);
    const after = sim.economy.state.stockOf(0, 0);
    expect(after).toBeLessThan(before + 1e-4);
  });

  it('freeDistance 以内的地块不因距离被扣产出', () => {
    // (3,1) 距离枢纽 4 格，恰好等于 freeDistance
    const id = sim.entityOfTile(indexOf(3, 1));
    if (id >= 0) expect(sim.roads.logistics.efficiencyOf(id, 0)).toBe(1);
    expect(ROAD_FREE_DISTANCE).toBe(4);
  });
});

describe('绑定与复位', () => {
  it('拆掉建筑后同一槽位重建不会继承旧效率', () => {
    const far = indexOf(GRID_COLS - 1, GRID_ROWS - 1);
    expect(sim.build(GRID_COLS - 1, GRID_ROWS - 1, 'house').ok).toBe(true);
    const farId = sim.entityOfTile(far);
    const farEff = sim.roads.logistics.efficiencyOf(farId, 0);
    expect(farEff).toBeLessThan(1);

    sim.build(GRID_COLS - 1, GRID_ROWS - 1, 'remove');
    // 就在枢纽旁边重建，会复用同一个槽位
    expect(sim.build(1, 0, 'house').ok).toBe(true);
    const newId = sim.entityOfTile(indexOf(1, 0));
    expect(sim.roads.logistics.efficiencyOf(newId, 0)).toBe(1);
  });

  it('读档后不会留下幽灵挡板', () => {
    const bytes = sim.economy.save();
    const edgeCount = sim.roads.graph.edgeCount;

    // 建一堵墙，图变了
    wallColumn(sim, 6);
    expect(sim.roads.graph.edgeCount).not.toBe(edgeCount);

    sim.economy.load(bytes);
    sim.rebuild();

    // 回到存档时的拓扑：(1,1) 附近那块初始挡板仍在，(6,*) 这一列应当干净
    for (let row = 0; row < GRID_ROWS; row += 1) {
      expect(sim.roads.isWall(indexOf(6, row))).toBe(false);
    }
    expect(sim.roads.wallCount).toBe(sim.countOf(Cell.Wall));
  });

  it('挡板计数与投影一致', () => {
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      if (sim.cells[tile] === Cell.Wall) expect(sim.roads.isWall(tile)).toBe(true);
      else expect(sim.roads.isWall(tile)).toBe(false);
    }
    expect(sim.roads.wallCount).toBe(sim.countOf(Cell.Wall));
  });
});
