/**
 * 城市仿真层 —— 经济内核与渲染之间的唯一中间人。
 *
 * 架构决定（ADR-007）：**经济层是格子归属的唯一真相**，本层的 `cells` / `entityAt`
 * 只是它的一次投影缓存。之前 `city.ts` 自己存 `cells`、经济层另存 `buildingTile`，
 * 两套数据靠手工同步 —— 那条路必然会出现「看得见建筑但拆不掉」的窗口期。
 *
 * 投影怎么保持一致：
 * - 放置 / 拆除只走 `economy.applyCommand`，状态变更后由事件回调**增量**更新投影；
 * - 读档、`init` 这类批量变更走 `rebuild()` 全量重建；
 * - `verifyProjection()` 拿经济层实体池反查投影，诊断面板里实时显示是否一致。
 *   它是这套设计的保险丝：一旦有人绕过指令队列直接改 `state`，这里立刻变红。
 *
 * 本文件不 import 任何渲染包，只 import 经济内核与几何常量。
 */

import { Economy, RES_STRIDE, type EconomyDiagnostics } from '@tabby/economy';
import { Cell, TILE_COUNT, indexOf, inGrid, type CellKind } from './city';
import {
  DEF,
  DEMO_BUILDINGS,
  DEMO_CONFIG,
  DEMO_RESOURCES,
  INITIAL_FOOD,
  INITIAL_POPULATION,
  INITIAL_TREASURY,
  MAX_FARMS,
} from './defs';

export type ToolKind = 'house' | 'farm' | 'wall' | 'remove';
export type BuildTool = Exclude<ToolKind, 'remove'>;

export const TOOLS: readonly ToolKind[] = ['house', 'farm', 'wall', 'remove'];

export const TOOL_LABEL: Record<ToolKind, string> = {
  house: '住宅',
  farm: '农田',
  wall: '挡板',
  remove: '拆除',
};

/** 工具栏 → 建筑定义下标。 */
const TOOL_DEF: Record<BuildTool, number> = {
  house: DEF.House,
  farm: DEF.Farm,
  wall: DEF.Wall,
};

/** 建筑定义下标 → 格子类型。下标顺序必须与 `DEMO_BUILDINGS` 一致。 */
const DEF_CELL: readonly CellKind[] = [Cell.House, Cell.Farm, Cell.Wall];

/** 造价从建筑表派生，不另存一份常量 —— 两处真相迟早会对不上。 */
export const COST: Record<BuildTool, number> = {
  house: DEMO_BUILDINGS[DEF.House]?.buildCost ?? 0,
  farm: DEMO_BUILDINGS[DEF.Farm]?.buildCost ?? 0,
  wall: DEMO_BUILDINGS[DEF.Wall]?.buildCost ?? 0,
};

export function costOf(tool: ToolKind): number {
  return tool === 'remove' ? 0 : COST[tool];
}

export function labelOf(tool: ToolKind): string {
  return TOOL_LABEL[tool];
}

/**
 * 开局布局。空网格会让人以为渲染挂了，所以首屏必须有东西；
 * 顺便让水流有落点 —— 三块田在挡板下游，开局就能看到灌溉。
 */
const SEED_LAYOUT: readonly (readonly [number, number, BuildTool])[] = [
  [1, 1, 'house'],
  [2, 1, 'house'],
  [3, 1, 'house'],
  [1, 3, 'farm'],
  [2, 3, 'farm'],
  [5, 2, 'wall'],
  [8, 1, 'house'],
  [8, 2, 'house'],
  [0, 3, 'farm'],
];

const SEED_COST = SEED_LAYOUT.reduce((sum, [, , tool]) => sum + COST[tool], 0);

/**
 * 灌溉折算：每 25 单位吸收水量折算 3 金币收成。
 *
 * 这两个数是实测出来的，不是拍的：low 档（180 粒子）下跑 10 天，三块田合计吸收
 * 约 250 单位水，折算 30 金币 ≈ 3/天 ≈ 90/月。同期的月税收约 34、维护费约 12.5，
 * 所以水塔浇灌是**主要收入**，税收是补贴 —— 这样玩家一开局就会被迫去摆农田、
 * 调挡板，而不是干等着房子生钱。
 *
 * 曾经设成 12 单位 / 8 金币，10 天能刷出 168 金币，两分钟就把地买满，玩法直接塌了。
 */
const IRRIGATION_UNIT = 25;
const IRRIGATION_REWARD = 3;

const SAVE_KEY = 'tabby-demo-save-v1';

export interface BuildResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * HUD 快照。每秒重建一次，不在热路径，所以允许返回普通对象。
 *
 * 字段**不加 readonly**：调用方要用 `Object.assign(hud, sim.hud())` 把快照灌进一个
 * reactive 对象，readonly 会顺着映射类型传染出去，赋值全部报错。
 */
export interface CityHud {
  treasury: number;
  population: number;
  housing: number;
  jobs: number;
  employed: number;
  satisfaction: number;
  starving: boolean;
  day: number;
  month: number;
  year: number;
  houseCount: number;
  farmCount: number;
  wallCount: number;
  foodStock: number;
  /** 当日产量与消耗，来自内核的 scratch 数组 —— 用来暴露产耗失衡，见 App 的 HUD 注释。 */
  foodProduced: number;
  foodConsumed: number;
  foodPrice: number;
  gdp: number;
  buildings: number;
  /** 灌溉累计收入。水落到田里就消失，画面上几乎看不出来，用这个数字给玩家反馈。 */
  waterIncome: number;
}

export class CitySimulation {
  readonly economy: Economy;
  /** 格子 → 类型投影。渲染与物理几何都读它。 */
  readonly cells: Int8Array;
  /** 格子 → 实体 id，-1 表示空。拆除时靠它反查。 */
  readonly entityAt: Int32Array;
  readonly city: number;

  private readonly clock: () => number;
  private lastReject = '';
  private irrigBuffer = 0;
  private earnedFromWater = 0;

  constructor(city = 0) {
    this.city = city;
    this.cells = new Int8Array(TILE_COUNT);
    this.entityAt = new Int32Array(TILE_COUNT).fill(-1);
    this.clock = () => performance.now();

    this.economy = new Economy({
      ...DEMO_CONFIG,
      resourceDefs: DEMO_RESOURCES,
      buildingDefs: DEMO_BUILDINGS,
      clock: this.clock,
    });

    // 先订阅再放置种子建筑：种子也必须经过投影回调，否则开局投影就是空的
    this.economy.bus.on('building-placed', ({ id, tile, def }) => this.onPlaced(id, tile, def));
    this.economy.bus.on('building-removed', ({ id, tile }) => this.onRemoved(id, tile));
    this.economy.bus.on('warning', ({ message }) => {
      this.lastReject = message;
    });

    // 初期金库 = 玩家可用金币 + 种子建筑造价：种子走正规指令队列所以要付得起，
    // 但玩家看到的是扣完之后的 160，不理解为「开局送 555」。
    this.economy.init({
      population: [INITIAL_POPULATION],
      stock: [[INITIAL_FOOD]],
      treasury: [INITIAL_TREASURY + SEED_COST],
    });

    for (const [col, row, tool] of SEED_LAYOUT) this.placeRaw(col, row, TOOL_DEF[tool]);

    // 种子放完金库应恰好剩 INITIAL_TREASURY；对不上说明 seed 有建筑被拒了
    if (this.treasury !== INITIAL_TREASURY) {
      this.economy.applyCommand({ type: 'deposit', city, amount: INITIAL_TREASURY - this.treasury });
    }
  }

  get treasury(): number {
    return this.economy.state.cityTreasury[this.city] ?? 0;
  }

  /** 该格子的实体 id，空返回 -1。 */
  entityOfTile(tile: number): number {
    if (tile < 0 || tile >= TILE_COUNT) return -1;
    return this.entityAt[tile] ?? -1;
  }

  cellAt(col: number, row: number): CellKind {
    if (!inGrid(col, row)) return Cell.Empty;
    return (this.cells[indexOf(col, row)] ?? Cell.Empty) as CellKind;
  }

  /** 玩家操作入口。所有校验都做在「下指令之前」，经济层只负责兜底。 */
  build(col: number, row: number, tool: ToolKind): BuildResult {
    if (!inGrid(col, row)) return { ok: false, message: '超出地块范围' };
    const tile = indexOf(col, row);

    if (tool === 'remove') {
      const id = this.entityOfTile(tile);
      if (id < 0) return { ok: false, message: '这里是空的' };
      const defIndex = this.economy.state.buildingType[id] ?? 0;
      const refund = Math.floor((DEMO_BUILDINGS[defIndex]?.buildCost ?? 0) * 0.5);
      if (!this.economy.applyCommand({ type: 'remove-building', id })) {
        return { ok: false, message: this.lastReject || '拆除失败' };
      }
      return { ok: true, message: `已拆除，返还 ${refund} 金币` };
    }

    if (this.cellAt(col, row) !== Cell.Empty) return { ok: false, message: '这里已经有建筑了' };
    if (tool === 'farm' && this.countOf(Cell.Farm) >= MAX_FARMS) {
      return { ok: false, message: `农田最多 ${MAX_FARMS} 块（水流吸收区上限）` };
    }
    const cost = COST[tool];
    if (this.treasury < cost) return { ok: false, message: `金币不足，需要 ${cost}` };

    if (!this.economy.applyCommand({ type: 'place-building', city: this.city, tile, def: TOOL_DEF[tool] })) {
      return { ok: false, message: this.lastReject || '建造失败' };
    }
    return { ok: true, message: `已建造${TOOL_LABEL[tool]}（-${cost}）` };
  }

  /** 只推进时间。返回是否跨过月末，供 UI 弹提示。 */
  advance(deltaMs: number): boolean {
    const report = this.economy.advance(deltaMs);
    return report.monthTicks > 0;
  }

  setSpeed(speed: 1 | 2 | 4): void {
    this.economy.setSpeed(speed);
  }

  /**
   * 水流灌溉结算。返回本次折算到的金币（0 表示还没攒够一格）。
   *
   * 为什么走 `deposit` 而不是直接改 `cityStock`：内核的边界是「改世界只能走指令」，
   * 一旦这里开个直接加库存的后门，回放与多人同步就会从这条路径开始漏。
   */
  irrigate(units: number): number {
    if (!(units > 0)) return 0;
    this.irrigBuffer += units;
    let earned = 0;
    while (this.irrigBuffer >= IRRIGATION_UNIT) {
      this.irrigBuffer -= IRRIGATION_UNIT;
      // 金库已被钳制在 [0, 2e9]，满仓时 deposit 静默无效，这里不必再判
      this.economy.applyCommand({ type: 'deposit', city: this.city, amount: IRRIGATION_REWARD });
      earned += IRRIGATION_REWARD;
    }
    this.earnedFromWater += earned;
    return earned;
  }

  get waterIncome(): number {
    return this.earnedFromWater;
  }

  countOf(kind: CellKind): number {
    let n = 0;
    for (let i = 0; i < TILE_COUNT; i += 1) if (this.cells[i] === kind) n += 1;
    return n;
  }

  hud(): CityHud {
    const snapshot = this.economy.getCity(this.city);
    const diag = this.economy.getDiagnostics();
    const stockAt = this.city * RES_STRIDE;
    return {
      treasury: Math.floor(snapshot?.treasury ?? 0),
      population: Math.round(snapshot?.population ?? 0),
      housing: Math.round(snapshot?.housing ?? 0),
      jobs: Math.round(snapshot?.jobs ?? 0),
      employed: Math.round(snapshot?.employed ?? 0),
      satisfaction: snapshot?.satisfaction ?? 0.5,
      starving: snapshot?.starving ?? false,
      day: diag.day,
      month: diag.month,
      year: diag.year,
      houseCount: this.countOf(Cell.House),
      farmCount: this.countOf(Cell.Farm),
      wallCount: this.countOf(Cell.Wall),
      foodStock: this.economy.state.stockOf(this.city, 0),
      foodProduced: this.economy.state.scratchProduced[stockAt] ?? 0,
      foodConsumed: this.economy.state.scratchConsumed[stockAt] ?? 0,
      foodPrice: diag.prices[0] ?? 0,
      gdp: diag.gdp,
      buildings: diag.aliveBuildings,
      waterIncome: this.earnedFromWater,
    };
  }

  diagnostics(): EconomyDiagnostics {
    return this.economy.getDiagnostics();
  }

  /**
   * 投影一致性自检：拿实体池反查投影。
   *
   * 这是「经济层当真相」这套设计的保险丝。返回 false 说明有人绕过了指令队列。
   */
  verifyProjection(): { readonly ok: boolean; readonly detail: string } {
    const state = this.economy.state;
    let mismatch = 0;
    const aliveTiles = new Int32Array(TILE_COUNT).fill(-1);

    for (let id = 0; id < state.capacity; id += 1) {
      if (state.alive[id] === 0) continue;
      if ((state.buildingCity[id] as number) !== this.city) continue;
      const tile = state.buildingTile[id] as number;
      if (tile < 0 || tile >= TILE_COUNT) {
        mismatch += 1;
        continue;
      }
      aliveTiles[tile] = id;
    }

    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      if ((aliveTiles[tile] ?? -1) !== (this.entityAt[tile] ?? -1)) mismatch += 1;
    }

    if (mismatch === 0) return { ok: true, detail: `投影一致（${TILE_COUNT} 格）` };
    return { ok: false, detail: `投影与实体池有 ${mismatch} 处不一致` };
  }

  /** 全量重建投影。读档、外部改 state 之后必须调用。 */
  rebuild(): void {
    this.cells.fill(Cell.Empty);
    this.entityAt.fill(-1);
    const state = this.economy.state;
    for (let id = 0; id < state.capacity; id += 1) {
      if (state.alive[id] === 0) continue;
      if ((state.buildingCity[id] as number) !== this.city) continue;
      this.onPlaced(id, state.buildingTile[id] as number, state.buildingType[id] as number);
    }
  }

  saveToStorage(): boolean {
    try {
      const bytes = this.economy.save();
      localStorage.setItem(SAVE_KEY, toBase64(bytes));
      return true;
    } catch {
      return false;
    }
  }

  loadFromStorage(): boolean {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw === null) return false;
      this.economy.load(fromBase64(raw));
      // 读档是批量替换，增量回调收不到，必须全量重建
      this.rebuild();
      return true;
    } catch {
      return false;
    }
  }

  hasSave(): boolean {
    try {
      return localStorage.getItem(SAVE_KEY) !== null;
    } catch {
      return false;
    }
  }

  private placeRaw(col: number, row: number, defIndex: number): void {
    this.economy.applyCommand({ type: 'place-building', city: this.city, tile: indexOf(col, row), def: defIndex });
  }

  private onPlaced(id: number, tile: number, defIndex: number): void {
    if (tile < 0 || tile >= TILE_COUNT) return;
    this.entityAt[tile] = id;
    this.cells[tile] = DEF_CELL[defIndex] ?? Cell.Empty;
  }

  private onRemoved(id: number, tile: number): void {
    if (tile < 0 || tile >= TILE_COUNT) {
      // 老存档里的实体可能没有 tile，退化成线性反查
      for (let i = 0; i < TILE_COUNT; i += 1) {
        if (this.entityAt[i] === id) {
          this.entityAt[i] = -1;
          this.cells[i] = Cell.Empty;
          return;
        }
      }
      return;
    }
    if (this.entityAt[tile] !== id) {
      // id 对不上说明投影已经漂了，交给 verifyProjection 报出来，这里只做保守清理
      this.entityAt[tile] = -1;
      this.cells[tile] = Cell.Empty;
      return;
    }
    this.entityAt[tile] = -1;
    this.cells[tile] = Cell.Empty;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
