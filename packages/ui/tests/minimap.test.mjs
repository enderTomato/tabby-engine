/**
 * 小地图测试。
 *
 * `render()` 是纯像素操作，可以在 Node 里直接验证；
 * `blit()` / `toDataUrl()` 依赖 canvas，Node 环境下走的是「提前返回」那条分支 ——
 * 这里也顺手断言它们不会在无 DOM 时抛错（服务端渲染、Worker 里都可能调到）。
 *
 * 这个类搬进 `@tabby/ui` 之后不再认识「城市」：调色板、枢纽格、断供色
 * 全部由 `spec` 注入。所以除了城市那份 spec，这里还用一个虚构的 3×2 网格
 * 验证「换个玩法/换张图也能用」—— 那是拆分这个包的唯一理由。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Minimap } from '../dist/index.js';

/** 虚构的小地图：3 列 2 行，两个标记点，一条断供色。 */
const TOY_SPEC = {
  cols: 3,
  rows: 2,
  palette: [0x000000, 0xff0000, 0x00ff00, 0x0000ff],
  pins: [{ tile: 0, color: 0xffd166 }],
  blockedTint: 0x333333,
  emptyValue: 0,
  scale: 10,
};

/** 城市那份 spec 的等价物（12×6，palette 与 Cell 对齐）。 */
const CITY_SPEC = {
  cols: 12,
  rows: 6,
  palette: [0x000000, 0xc9714a, 0x54b25a, 0x6d7f95],
  pins: [{ tile: 0, color: 0xffd166 }],
  blockedTint: 0x8a1f1f,
  emptyValue: 0,
  scale: 12,
};

function pixelAt(map, tile) {
  const at = tile * 4;
  return [map.pixels[at], map.pixels[at + 1], map.pixels[at + 2], map.pixels[at + 3]];
}

function makeCells(spec, fills) {
  const cells = new Int8Array(spec.cols * spec.rows);
  for (const [tile, kind] of fills) cells[tile] = kind;
  return cells;
}

test('尺寸是 1 格 1 像素（真缩略图，不是小画布重绘）', () => {
  const map = new Minimap(CITY_SPEC, makeCells(CITY_SPEC, []));
  assert.equal(map.pixels.length, 12 * 6 * 4);
  assert.ok(CITY_SPEC.scale > 1);
});

test('建筑颜色取自注入的调色板，空格是纯黑且不透明', () => {
  const map = new Minimap(CITY_SPEC, makeCells(CITY_SPEC, [[13, 1], [14, 2], [15, 3]]));
  map.render();
  const house = pixelAt(map, 13);
  assert.equal(house[0], 0xc9);
  assert.equal(house[3], 255);

  // 换一个空格来断言：tile 0 是 pin（市政厅），不是空格
  assert.deepEqual(pixelAt(map, 12 + 4), [0, 0, 0, 255]);
  // 市政厅有独立高亮色，不会被当成空格
  assert.notDeepEqual(pixelAt(map, 0).slice(0, 3), [0, 0, 0]);
});

test('只在脏时重绘', () => {
  const map = new Minimap(CITY_SPEC, makeCells(CITY_SPEC, [[13, 1]]));
  map.render();
  const redraws = map.redraws;
  assert.equal(map.render(), false);
  assert.equal(map.redraws, redraws);

  map.invalidate();
  assert.equal(map.isDirty, true);
  assert.equal(map.render(), true);
  assert.equal(map.redraws, redraws + 1);
});

test('断供图层压暗建筑，空格不受影响', () => {
  const map = new Minimap(CITY_SPEC, makeCells(CITY_SPEC, [[14, 2]]));
  map.render();
  const normal = pixelAt(map, 14);

  assert.equal(map.setBlocked(14, true), true);
  assert.equal(map.isDirty, true);
  map.render();
  assert.notDeepEqual(pixelAt(map, 14), normal);

  // 空格即使被标脏也不改颜色（避免空地上出现红点）
  map.setBlocked(12 + 4, true);
  map.render();
  assert.deepEqual(pixelAt(map, 12 + 4), [0, 0, 0, 255]);

  // 重复设置同一个值不该触发重绘
  map.render();
  assert.equal(map.setBlocked(14, true), false);
  assert.equal(map.isDirty, false);
});

test('setBlockedTiles 一次性刷新，返回是否有变化，且不分配新数组', () => {
  const map = new Minimap(CITY_SPEC, makeCells(CITY_SPEC, [[14, 2]]));
  map.render();
  assert.equal(map.setBlockedTiles([14]), true);
  assert.equal(map.setBlockedTiles([14]), false);
  assert.equal(map.setBlockedTiles([13, 14]), true);
  assert.equal(map.setBlockedTiles([]), true);
  // 越界索引被安静忽略，不该抛
  assert.equal(map.setBlockedTiles([-1, 999]), false);
});

test('pin 优先于调色板与断供层', () => {
  const map = new Minimap(TOY_SPEC, makeCells(TOY_SPEC, [[0, 2]]));
  map.setBlocked(0, true);
  map.render();
  assert.deepEqual(pixelAt(map, 0), [0xff, 0xd1, 0x66, 0xff]);
});

test('调色板查不到时走 fallbackColor 而不是 undefined', () => {
  const spec = { cols: 2, rows: 1, palette: [0x000000], fallbackColor: 0xabcdef };
  const cells = makeCells(spec, [[1, 7]]);
  const map = new Minimap(spec, cells);
  map.render();
  assert.deepEqual(pixelAt(map, 1), [0xab, 0xcd, 0xef, 0xff]);
});

test('任意网格尺寸都能跑（这是抽成 ui 包的唯一理由）', () => {
  const map = new Minimap(TOY_SPEC, makeCells(TOY_SPEC, [[4, 2]]));
  assert.equal(map.cols, 3);
  assert.equal(map.rows, 2);
  assert.equal(map.tileCount, 6);
  map.render();
  assert.deepEqual(pixelAt(map, 4), [0x00, 0xff, 0x00, 0xff]);
});

test('cells 长度不足时构造期就抛，而不是渲染时读到 undefined', () => {
  assert.throws(() => new Minimap(TOY_SPEC, new Int8Array(3)), RangeError);
});

test('无 DOM 环境下 toDataUrl 返回 null 而不是抛错', () => {
  const map = new Minimap(CITY_SPEC, makeCells(CITY_SPEC, []));
  assert.equal(map.toDataUrl(), null);
});
