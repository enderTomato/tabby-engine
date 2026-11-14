/**
 * 小地图的「城市外观」参数。
 *
 * `@tabby/ui` 的 `Minimap` 只认格子值数组与调色板，不认识住宅/农田/市政厅。
 * 「住宅是砖红、农田是绿、市政厅是金色」属于**玩法知识**，所以留在这一侧注入。
 *
 * 单独成文件是为了打断循环依赖：`city.ts` 是纯几何，`logistics.ts` 依赖它，
 * 而小地图又要用到 `logistics` 里的枢纽格 —— 三者没有谁该 import 谁。
 */

import type { MinimapSpec } from '@tabby/ui';
import { CELL_COLOR, Cell, GRID_COLS, GRID_ROWS } from './city.js';
import { HUB_TILE } from './logistics.js';

/** 市政厅格子的颜色：金色，与其它建筑区分。 */
export const HUB_COLOR = 0xffd166;
/** 断供建筑的颜色：压暗的红，叠在原本的颜色上。 */
export const BLOCKED_TINT = 0x8a1f1f;
/** 缩略图的默认放大倍数（12×6 像素 → 144×72 CSS 像素）。 */
export const MINIMAP_SCALE = 12;

/**
 * 格子值 → 颜色。
 *
 * `CELL_COLOR` 是 `Record<number, number>`（有洞的映射），
 * `Minimap` 要的是稠密数组（下标直接寻址，渲染热路径上不能做两次查表）。
 * 这里按 `Cell` 的值展开成数组，长度取 `Cell` 的最大值 + 1。
 */
const PALETTE: readonly number[] = (() => {
  const max = Math.max(...Object.values(Cell));
  const out = new Array<number>(max + 1).fill(0x000000);
  for (const [key, value] of Object.entries(CELL_COLOR)) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && index <= max) out[index] = value;
  }
  return out;
})();

export const CITY_MINIMAP_SPEC: MinimapSpec = {
  cols: GRID_COLS,
  rows: GRID_ROWS,
  palette: PALETTE,
  pins: [{ tile: HUB_TILE, color: HUB_COLOR }],
  blockedTint: BLOCKED_TINT,
  emptyValue: Cell.Empty,
  scale: MINIMAP_SCALE,
};
