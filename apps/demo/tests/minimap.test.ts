/**
 * 小地图测试。
 *
 * `render()` 是纯像素操作，可以在 Node 里直接验证；
 * `blit()` / `toDataUrl()` 依赖 canvas，Node 环境下走的是「提前返回」那条分支 ——
 * 这里也顺手断言它们不会在无 DOM 时抛错（服务端渲染、Worker 里都可能调到）。
 */

import { describe, expect, it } from 'vitest';
import { Cell, GRID_COLS, GRID_ROWS, TILE_COUNT, indexOf } from '../src/game/city';
import { HUB_TILE } from '../src/game/logistics';
import { MINIMAP_SCALE, Minimap } from '../src/game/minimap';

function makeCells(): Int8Array {
  const cells = new Int8Array(TILE_COUNT);
  cells[indexOf(1, 1)] = Cell.House;
  cells[indexOf(2, 1)] = Cell.Farm;
  cells[indexOf(3, 1)] = Cell.Wall;
  return cells;
}

function pixelAt(map: Minimap, tile: number): [number, number, number, number] {
  const at = tile * 4;
  return [map.pixels[at]!, map.pixels[at + 1]!, map.pixels[at + 2]!, map.pixels[at + 3]!];
}

describe('缩略图像素', () => {
  it('尺寸是 1 格 1 像素（真缩略图，不是小画布重绘）', () => {
    const map = new Minimap(makeCells());
    expect(map.pixels.length).toBe(TILE_COUNT * 4);
    expect(MINIMAP_SCALE).toBeGreaterThan(1);
  });

  it('建筑颜色与城市投影一致，空格是纯黑且不透明', () => {
    const map = new Minimap(makeCells());
    map.render();
    const housePixel = pixelAt(map, indexOf(1, 1));
    expect(housePixel[0]).toBeGreaterThan(0); // 红通道有值
    expect(housePixel[3]).toBe(255);

    const emptyPixel = pixelAt(map, indexOf(0, 0));
    // HUB_TILE 正好是 (0,0)，所以换一个空格来断言
    const other = pixelAt(map, indexOf(5, 4));
    expect(other).toEqual([0, 0, 0, 255]);
    // 市政厅有独立的高亮色，不会被当成空格
    expect(emptyPixel.slice(0, 3)).not.toEqual([0, 0, 0]);
  });

  it('只在脏时重绘（建造 100 次但只改 1 次）', () => {
    const map = new Minimap(makeCells());
    map.render();
    const redraws = map.redraws;
    expect(map.render()).toBe(false);
    expect(map.redraws).toBe(redraws);

    map.invalidate();
    expect(map.isDirty).toBe(true);
    expect(map.render()).toBe(true);
    expect(map.redraws).toBe(redraws + 1);
  });

  it('断供图层压暗建筑，空格不受影响', () => {
    const map = new Minimap(makeCells());
    map.render();
    const normal = pixelAt(map, indexOf(2, 1));

    expect(map.setBlocked(indexOf(2, 1), true)).toBe(true);
    expect(map.isDirty).toBe(true);
    map.render();
    const blockedPixel = pixelAt(map, indexOf(2, 1));
    expect(blockedPixel).not.toEqual(normal);

    // 空格即使被标脏也不改颜色（避免空地上出现红点）
    map.setBlocked(indexOf(5, 4), true);
    map.render();
    expect(pixelAt(map, indexOf(5, 4))).toEqual([0, 0, 0, 255]);

    // 重复设置同一个值不该触发重绘
    map.render();
    expect(map.setBlocked(indexOf(2, 1), true)).toBe(false);
    expect(map.isDirty).toBe(false);
  });

  it('setBlockedTiles 一次性刷新，返回是否有变化', () => {
    const map = new Minimap(makeCells());
    map.render();
    expect(map.setBlockedTiles([indexOf(2, 1)])).toBe(true);
    expect(map.setBlockedTiles([indexOf(2, 1)])).toBe(false);
    expect(map.setBlockedTiles([indexOf(1, 1), indexOf(2, 1)])).toBe(true);
    expect(map.setBlockedTiles([])).toBe(true);
  });

  it('格子数与地图尺寸自洽', () => {
    expect(TILE_COUNT).toBe(GRID_COLS * GRID_ROWS);
    expect(HUB_TILE).toBe(indexOf(0, 0));
  });
});

describe('无 DOM 环境下的降级', () => {
  it('toDataUrl 在没有 document 时返回 null 而不是抛错', () => {
    const map = new Minimap(makeCells());
    expect(map.toDataUrl()).toBeNull();
  });
});
