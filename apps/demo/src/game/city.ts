/**
 * 迷你经营逻辑（纯数据，不碰 DOM / 渲染）。
 * 刻意写得很小：测试用例验证的是引擎链路，不是玩法深度。
 */

export type CellKind = 'empty' | 'house' | 'farm' | 'wall';
export type ToolKind = 'house' | 'farm' | 'wall' | 'remove';

export const CELL_SIZE = 2;
export const GRID_COLS = 12;
export const GRID_ROWS = 6;
export const WORLD_MIN_X = -12;
export const WORLD_MIN_Y = 0;
export const MAX_FARMS = 8;

export const TOWER = { x: -13.6, y: 0, width: 1.6, height: 13 } as const;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CityState {
  cells: CellKind[];
  coins: number;
  houses: number;
  farms: number;
  /** 每块农田累计吸收的水量。 */
  farmWater: number[];
}

export const COSTS: Record<ToolKind, number> = {
  house: 40,
  farm: 60,
  wall: 15,
  remove: 0,
};

export const TOOL_LABEL: Record<ToolKind, string> = {
  house: '房屋',
  farm: '农田',
  wall: '挡板',
  remove: '拆除',
};

export const CELL_COLOR: Record<CellKind, number> = {
  empty: 0x000000,
  house: 0xc9714a,
  farm: 0x54b25a,
  wall: 0x6d7f95,
};

/**
 * 开局自带的几栋建筑。
 * 空网格会让人以为渲染挂了 —— 首屏必须有东西可看，顺便也让水流有落点。
 */
const SEED_LAYOUT: readonly (readonly [number, number, CellKind])[] = [
  [1, 1, 'house'],
  [2, 1, 'house'],
  [3, 1, 'house'],
  [1, 3, 'farm'],
  [2, 3, 'farm'],
  [5, 2, 'wall'],
  [8, 1, 'house'],
  [8, 2, 'house'],
  [9, 4, 'farm'],
];

export function createCity(): CityState {
  const cells = new Array<CellKind>(GRID_COLS * GRID_ROWS).fill('empty');
  let houses = 0;
  let farms = 0;
  for (const [col, row, kind] of SEED_LAYOUT) {
    cells[indexOf(col, row)] = kind;
    if (kind === 'house') houses += 1;
    else if (kind === 'farm') farms += 1;
  }
  return {
    cells,
    coins: 160,
    houses,
    farms,
    farmWater: new Array<number>(farms).fill(0),
  };
}

export function indexOf(col: number, row: number): number {
  return row * GRID_COLS + col;
}

export function inGrid(col: number, row: number): boolean {
  return col >= 0 && col < GRID_COLS && row >= 0 && row < GRID_ROWS;
}

export function cellAt(city: CityState, col: number, row: number): CellKind {
  if (!inGrid(col, row)) return 'empty';
  return city.cells[indexOf(col, row)] ?? 'empty';
}

export function cellRect(col: number, row: number): Rect {
  return {
    x: WORLD_MIN_X + col * CELL_SIZE,
    y: WORLD_MIN_Y + row * CELL_SIZE,
    width: CELL_SIZE,
    height: CELL_SIZE,
  };
}

export interface BuildResult {
  readonly ok: boolean;
  readonly message: string;
}

/** 放置/拆除。返回是否成功与提示文案（直接显示在 HUD 上）。 */
export function applyTool(city: CityState, col: number, row: number, tool: ToolKind): BuildResult {
  if (!inGrid(col, row)) return { ok: false, message: '超出地块范围' };
  const index = indexOf(col, row);
  const current = city.cells[index] ?? 'empty';

  if (tool === 'remove') {
    if (current === 'empty') return { ok: false, message: '这里是空的' };
    city.cells[index] = 'empty';
    if (current === 'house') city.houses = Math.max(0, city.houses - 1);
    if (current === 'farm') {
      city.farms = Math.max(0, city.farms - 1);
      city.farmWater = city.farmWater.slice(0, city.farms);
    }
    city.coins += Math.floor(COSTS.house / 2);
    return { ok: true, message: `已拆除，返还 ${Math.floor(COSTS.house / 2)} 金币` };
  }

  if (current !== 'empty') return { ok: false, message: '这里已经有建筑了' };
  if (tool === 'farm' && row !== 0) return { ok: false, message: '农田只能建在地面一层' };
  if (tool === 'farm' && city.farms >= MAX_FARMS) {
    return { ok: false, message: `农田最多 ${MAX_FARMS} 块（吸收区数量上限）` };
  }
  const cost = COSTS[tool];
  if (city.coins < cost) return { ok: false, message: `金币不足，需要 ${cost}` };

  city.coins -= cost;
  city.cells[index] = tool;
  if (tool === 'house') city.houses += 1;
  if (tool === 'farm') {
    city.farms += 1;
    city.farmWater = [...city.farmWater, 0];
  }
  return { ok: true, message: `已建造${TOOL_LABEL[tool]}（-${cost}）` };
}

export function obstaclesOf(city: CityState): { id: string; min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number }; kind: 'solid' }[] {
  const list: { id: string; min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number }; kind: 'solid' }[] = [
    {
      id: 'tower',
      min: { x: TOWER.x, y: 0, z: -1.6 },
      max: { x: TOWER.x + TOWER.width, y: TOWER.height, z: 1.6 },
      kind: 'solid',
    },
  ];
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      const kind = cellAt(city, col, row);
      if (kind !== 'house' && kind !== 'wall') continue;
      const rect = cellRect(col, row);
      list.push({
        id: `cell-${col}-${row}`,
        min: { x: rect.x + 0.1, y: rect.y, z: -1.6 },
        max: { x: rect.x + rect.width - 0.1, y: rect.y + rect.height, z: 1.6 },
        kind: 'solid',
      });
    }
  }
  return list;
}

export function zonesOf(city: CityState): { id: string; min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }[] {
  const zones: { id: string; min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }[] = [];
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      if (cellAt(city, col, row) !== 'farm') continue;
      const rect = cellRect(col, row);
      zones.push({
        id: `farm-${col}-${row}`,
        min: { x: rect.x, y: rect.y, z: -1.6 },
        max: { x: rect.x + rect.width, y: rect.y + rect.height * 0.6, z: 1.6 },
      });
    }
  }
  return zones;
}
