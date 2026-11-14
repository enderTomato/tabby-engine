/**
 * 地块几何与渲染样式 —— **不持有任何游戏状态**。
 *
 * 这个文件在接入经济内核之前叫 "城市状态"，里面有一份 `cells` 数组当真源。
 * 现在真源是 `@tabby/economy` 的实体池，这里的 `cells` 只是它的一次投影快照
 * （见 `simulation.ts`）。所以本文件退化成两层职责：
 *
 * 1. 网格坐标 ↔ 世界坐标的纯换算；
 * 2. 把「哪些格子有东西」翻译成物理引擎要的障碍盒与吸收区。
 *
 * 刻意不 import `@tabby/economy`：几何层不需要知道建筑有维护费。
 */

export const CELL_SIZE = 2;
export const GRID_COLS = 12;
export const GRID_ROWS = 6;
export const TILE_COUNT = GRID_COLS * GRID_ROWS;

export const WORLD_MIN_X = -12;
export const WORLD_MIN_Y = 0;

export const TOWER = { x: -13.6, y: 0, width: 1.6, height: 13 } as const;

/**
 * 格子类型。用数字下标而不是字符串联合，因为投影缓存在 `Int8Array` 里：
 * 72 格 × 每次建造重建一次，字符串数组会产生 72 个短生命周期对象，
 * 数字下标的拷贝是 `TypedArray.set` 一条指令。
 */
export const Cell = { Empty: 0, House: 1, Farm: 2, Wall: 3 } as const;

export type CellKind = (typeof Cell)[keyof typeof Cell];

/** 调试与存档用的可读名，下标与 `Cell` 对齐。 */
export const CELL_KEY: readonly string[] = ['empty', 'house', 'farm', 'wall'];

export const CELL_COLOR: Record<number, number> = {
  [Cell.Empty]: 0x000000,
  [Cell.House]: 0xc9714a,
  [Cell.Farm]: 0x54b25a,
  [Cell.Wall]: 0x6d7f95,
};

/** 3D 中的建筑高度。农田压扁、挡板加高 —— 光靠颜色区分在小屏上不够。 */
export const CELL_HEIGHT: Record<number, number> = {
  [Cell.Empty]: 0,
  [Cell.House]: CELL_SIZE,
  [Cell.Farm]: 1.2,
  [Cell.Wall]: 2,
};

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function indexOf(col: number, row: number): number {
  return row * GRID_COLS + col;
}

export function inGrid(col: number, row: number): boolean {
  return Number.isInteger(col) && Number.isInteger(row) && col >= 0 && col < GRID_COLS && row >= 0 && row < GRID_ROWS;
}

export function cellRect(col: number, row: number): Rect {
  return {
    x: WORLD_MIN_X + col * CELL_SIZE,
    y: WORLD_MIN_Y + row * CELL_SIZE,
    width: CELL_SIZE,
    height: CELL_SIZE,
  };
}

/** 从世界坐标反查格子。越界返回 null，调用方不必自己做两遍边界判断。 */
export function cellFromWorld(x: number, y: number): { readonly col: number; readonly row: number } | null {
  const col = Math.floor((x - WORLD_MIN_X) / CELL_SIZE);
  const row = Math.floor((y - WORLD_MIN_Y) / CELL_SIZE);
  if (!inGrid(col, row)) return null;
  return { col, row };
}

export interface SolidBox {
  readonly id: string;
  readonly min: { readonly x: number; readonly y: number; readonly z: number };
  readonly max: { readonly x: number; readonly y: number; readonly z: number };
  readonly kind: 'solid';
}

export interface AbsorbBox {
  readonly id: string;
  readonly min: { readonly x: number; readonly y: number; readonly z: number };
  readonly max: { readonly x: number; readonly y: number; readonly z: number };
}

/**
 * 把格子快照翻译成物理障碍。
 *
 * x/z 范围必须与 3D 渲染的盒子**逐格对齐**：早先这里写死 `z: ±1.6`，
 * 而渲染那边按 row 算 z，于是「看得见的建筑」和「能撞到的建筑」是两套位置 ——
 * 布娃娃会穿过楼、水会从墙边漏过去，而且从 2D 视图完全看不出来。
 *
 * 农田不参与碰撞：水要流进去，布娃娃也该能躺进去。
 */
export function obstaclesOf(cells: Int8Array): SolidBox[] {
  const list: SolidBox[] = [
    {
      id: 'tower',
      min: { x: TOWER.x, y: 0, z: -1.6 },
      max: { x: TOWER.x + TOWER.width, y: TOWER.height, z: 1.6 },
      kind: 'solid',
    },
  ];
  for (let row = 0; row < GRID_ROWS; row += 1) {
    const z = zSpanOf(row);
    for (let col = 0; col < GRID_COLS; col += 1) {
      const kind = cells[indexOf(col, row)] as CellKind;
      if (kind !== Cell.House && kind !== Cell.Wall) continue;
      const rect = cellRect(col, row);
      list.push({
        id: `cell-${col}-${row}`,
        min: { x: rect.x + 0.1, y: rect.y, z: z.min },
        max: { x: rect.x + rect.width - 0.1, y: rect.y + (CELL_HEIGHT[kind] ?? CELL_SIZE), z: z.max },
        kind: 'solid',
      });
    }
  }
  return list;
}

/**
 * 农田 → 水流吸收区。
 *
 * 高度只取 0.6 个格子：吸收判定发生在水落到田面上那一刻，
 * 画成全高会让在空中飘过的水粒子也被算成灌溉。
 */
export function zonesOf(cells: Int8Array): AbsorbBox[] {
  const zones: AbsorbBox[] = [];
  for (let row = 0; row < GRID_ROWS; row += 1) {
    const z = zSpanOf(row);
    for (let col = 0; col < GRID_COLS; col += 1) {
      if ((cells[indexOf(col, row)] as CellKind) !== Cell.Farm) continue;
      const rect = cellRect(col, row);
      zones.push({
        id: `farm-${col}-${row}`,
        min: { x: rect.x, y: rect.y, z: z.min },
        max: { x: rect.x + rect.width, y: rect.y + rect.height * 0.6, z: z.max },
      });
    }
  }
  return zones;
}

/**
 * row → 3D 的 z 轴。2D 视图里 `rect.y` 是「行纵深」，到了 3D 必须落到 z 上，
 * 直接当高度用会让所有建筑悬空。
 *
 * 取 -6 而不是 -4：物理世界的 z 边界是 ±6（见 `BOUNDS`），6 行 × 2 = 12 深度
 * 正好铺满。原来的 -4 会让最后一行伸出边界 —— 视觉上看不出来，但物理障碍有半截在界外，
 * 水会从那里漏出去。
 */
export const ROW_TO_Z = -6;

/**
 * 某一行的 z 范围。
 *
 * `Box3DSpec.z` 是**起点**而不是中心（渲染层用 `z + depth / 2` 定位），
 * 所以这里返回的也是起点。深度取 0.94 格，相邻行之间留 0.06 的缝，
 * 避免两排建筑的碰撞盒首尾相接把布娃娃卡住。
 */
export function zSpanOf(row: number): { readonly min: number; readonly max: number } {
  const min = ROW_TO_Z + row * CELL_SIZE;
  return { min, max: min + CELL_SIZE * 0.94 };
}
