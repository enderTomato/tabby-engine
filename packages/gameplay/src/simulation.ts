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

import { Economy, RES_STRIDE, buildingIndexOf, type EconomyDiagnostics } from '@tabby/economy';
import { Minimap } from '@tabby/ui';
import { Cell, TILE_COUNT, indexOf, inGrid, type CellKind } from './city.js';
import { BUILTIN_TABLE, type ConfigTable } from './config-table.js';
import { CITY_MINIMAP_SPEC } from './minimap-spec.js';
import { CityRoads, HUB_TILE } from './logistics.js';
import {
  CHUNKS_X,
  CHUNKS_Y,
  ChunkStreamer,
  mergeChunks,
  packChunks,
  readAllChunks,
  readDirectory,
  splitChunks,
} from './chunkstore.js';
import {
  DEMO_BUILDINGS,
  INITIAL_FOOD,
  INITIAL_POPULATION,
  INITIAL_TREASURY,
  MAX_FARMS,
} from './defs.js';

export type ToolKind = 'house' | 'farm' | 'wall' | 'remove';
export type BuildTool = Exclude<ToolKind, 'remove'>;

export const TOOLS: readonly ToolKind[] = ['house', 'farm', 'wall', 'remove'];

export const TOOL_LABEL: Record<ToolKind, string> = {
  house: '住宅',
  farm: '农田',
  wall: '挡板',
  remove: '拆除',
};

/** 建筑 key → 格子类型。按 key 映射而不是按下标，配置表重排也不会错位。 */
const KEY_CELL: Record<BuildTool, CellKind> = {
  house: Cell.House,
  farm: Cell.Farm,
  wall: Cell.Wall,
};

/** 造价（内置表）。UI 的工具栏标签用它；实例内的真实造价见 `sim.costOf`。 */
export const COST: Record<BuildTool, number> = {
  house: DEMO_BUILDINGS[buildingIndexOf(DEMO_BUILDINGS, 'house')]?.buildCost ?? 0,
  farm: DEMO_BUILDINGS[buildingIndexOf(DEMO_BUILDINGS, 'farm')]?.buildCost ?? 0,
  wall: DEMO_BUILDINGS[buildingIndexOf(DEMO_BUILDINGS, 'wall')]?.buildCost ?? 0,
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

/** 老格式：只有经济层字节的 base64。保留读取，写入时升级到 v2。 */
const SAVE_KEY_V1 = 'tabby-demo-save-v1';
/** 新格式：JSON，含经济层字节 + 分块地图快照 + 缩略图预览。 */
const SAVE_KEY = 'tabby-demo-save-v2';

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
  /** 本城生产建筑里被路网掐断（效率归零）的数量。 */
  blockedBuildings: number;
  /** 本城生产建筑总数，与 blockedBuildings 配对使用。 */
  supplyBuildings: number;
  /** 挡板造成的断路数量（诊断用，与 wallCount 不同：这个数只算「真的堵住了某条边」的）。 */
  roadBlocks: number;
}

export class CitySimulation {
  readonly economy: Economy;
  /** 格子 → 类型投影。渲染与物理几何都读它。 */
  readonly cells: Int8Array;
  /** 格子 → 实体 id，-1 表示空。拆除时靠它反查。 */
  readonly entityAt: Int32Array;
  readonly roads: CityRoads;
  readonly city: number;
  /** 本实例生效的配置表。热重载会换掉它并重建整个实例，所以它创建后不再变化。 */
  readonly table: ConfigTable;
  /** 离屏缩略图，脏了才重绘。 */
  readonly minimap: Minimap;

  /** 工具栏 → 建筑定义下标，按 key 从当前配置表查出来的。 */
  private readonly toolDef: Record<BuildTool, number>;
  private readonly toolCost: Record<BuildTool, number>;

  private readonly clock: () => number;
  private lastReject = '';
  private irrigBuffer = 0;
  private earnedFromWater = 0;
  /** 每多少单位吸收水折算一次收益（调试面板可改）。 */
  private irrigUnit = IRRIGATION_UNIT;
  /** 最近一次物流受阻提示，UI 取走后清空。 */
  private blockedNotice = '';
  private streamer: ChunkStreamer | null = null;

  constructor(city = 0, table: ConfigTable = BUILTIN_TABLE) {
    this.city = city;
    this.table = table;
    this.cells = new Int8Array(TILE_COUNT);
    this.entityAt = new Int32Array(TILE_COUNT).fill(-1);
    this.minimap = new Minimap(CITY_MINIMAP_SPEC, this.cells);
    this.clock = () => performance.now();

    this.toolDef = {
      house: buildingIndexOf(table.buildings, 'house'),
      farm: buildingIndexOf(table.buildings, 'farm'),
      wall: buildingIndexOf(table.buildings, 'wall'),
    };
    this.toolCost = {
      house: table.buildings[this.toolDef.house]?.buildCost ?? 0,
      farm: table.buildings[this.toolDef.farm]?.buildCost ?? 0,
      wall: table.buildings[this.toolDef.wall]?.buildCost ?? 0,
    };
    // 路网必须先于经济层就绪：物流 provider 在 Economy 构造时就要传进去，
    // 否则开局那批种子建筑会以「无物流」跑完第一天，产出凭空多一截。
    this.roads = new CityRoads(1);

    this.economy = new Economy({
      ...table.config,
      resourceDefs: table.resources,
      buildingDefs: table.buildings,
      clock: this.clock,
      logistics: this.roads.logistics,
    });

    // 先订阅再放置种子建筑：种子也必须经过投影回调，否则开局投影就是空的
    this.economy.bus.on('building-placed', ({ id, tile, def }) => this.onPlaced(id, tile, def));
    this.economy.bus.on('building-removed', ({ id, tile }) => this.onRemoved(id, tile));
    this.economy.bus.on('logistics-blocked', ({ city, blocked, total }) => {
      if (city !== this.city) return;
      this.blockedNotice = `物流受阻：${blocked}/${total} 座生产建筑无法到达市政厅`;
    });
    this.economy.bus.on('warning', ({ message }) => {
      this.lastReject = message;
    });

    // 初期金库 = 玩家可用金币 + 种子建筑造价：种子走正规指令队列所以要付得起，
    // 但玩家看到的是扣完之后的 160，不理解为「开局送 555」。
    const seedCost = SEED_LAYOUT.reduce((sum, [, , tool]) => sum + this.toolCost[tool], 0);
    this.economy.init({
      population: [INITIAL_POPULATION],
      stock: [[INITIAL_FOOD]],
      treasury: [INITIAL_TREASURY + seedCost],
    });

    for (const [col, row, tool] of SEED_LAYOUT) this.placeRaw(col, row, this.toolDef[tool]);

    // 种子放完金库应恰好剩 INITIAL_TREASURY；对不上说明 seed 有建筑被拒了
    if (this.treasury !== INITIAL_TREASURY) {
      this.economy.applyCommand({ type: 'deposit', city, amount: INITIAL_TREASURY - this.treasury });
    }
  }

  get treasury(): number {
    return this.economy.state.cityTreasury[this.city] ?? 0;
  }

  /** 本实例生效的造价（可能来自热重载后的配置表，与模块级 `COST` 不一定相同）。 */
  costOf(tool: ToolKind): number {
    return tool === 'remove' ? 0 : this.toolCost[tool];
  }

  /**
   * 刷新小地图。
   *
   * 每帧调用是安全的：`Minimap` 内部只在脏时重绘，
   * 而 `cells` 只在建造/拆除时变 —— 所以稳态下这里接近零成本。
   * 断供图层每次都要重算（效率随路网变化），但它是 72 次的数组写，
   * 比一次 canvas 绘制便宜得多。
   */
  refreshMinimap(): void {
    const blocked: number[] = [];
    const state = this.economy.state;
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      const id = this.entityAt[tile] ?? -1;
      if (id < 0) continue;
      const def = state.buildingType[id] as number;
      if ((this.table.buildings[def]?.output.length ?? 0) === 0) continue;
      // 用效率判据而不是「今天有没有产出」：产出为 0 可能是缺料，与断供是两件事
      if (this.roads.logistics.efficiencyOf(id, this.city) <= 0.01) blocked.push(tile);
    }
    // 只标脏，不在这里画：blit 时才真正 putImageData，
    // 否则「每帧刷新 → 立刻渲染 → 脏标记被清掉」会让 blit 判定为无需重绘。
    this.minimap.setBlockedTiles(blocked);
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
      const refund = Math.floor((this.table.buildings[defIndex]?.buildCost ?? 0) * 0.5);
      if (!this.economy.applyCommand({ type: 'remove-building', id })) {
        return { ok: false, message: this.lastReject || '拆除失败' };
      }
      return { ok: true, message: `已拆除，返还 ${refund} 金币` };
    }

    if (this.cellAt(col, row) !== Cell.Empty) return { ok: false, message: '这里已经有建筑了' };
    if (tool === 'farm' && this.countOf(Cell.Farm) >= MAX_FARMS) {
      return { ok: false, message: `农田最多 ${MAX_FARMS} 块（水流吸收区上限）` };
    }
    const cost = this.costOf(tool);
    if (this.treasury < cost) return { ok: false, message: `金币不足，需要 ${cost}` };

    if (!this.economy.applyCommand({ type: 'place-building', city: this.city, tile, def: this.toolDef[tool] })) {
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
    while (this.irrigBuffer >= this.irrigUnit) {
      this.irrigBuffer -= this.irrigUnit;
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

  get irrigationUnit(): number {
    return this.irrigUnit;
  }

  /**
   * 调整灌溉折算阈值。
   *
   * 改小等于直接印钱 —— 这是调试旋钮，不是玩法。下限 5 是「别让一帧的
   * 水量换算成几十笔 deposit」的工程限制（每笔都是一次指令队列入队）。
   */
  setIrrigationUnit(units: number): void {
    this.irrigUnit = Math.max(5, Math.round(units));
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
    // 两个数必须来自同一次统计，否则 HUD 会出现 3/2 这种鬼数字
    const supply = this.supply();
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
      blockedBuildings: supply.blocked,
      supplyBuildings: supply.total,
      roadBlocks: this.roads.wallCount,
    };
  }

  /** 取走物流受阻提示（一次性）。 */
  takeBlockedNotice(): string {
    const message = this.blockedNotice;
    this.blockedNotice = '';
    return message;
  }

  /**
   * 本城生产建筑的物流统计（受阻数 / 总数）。
   *
   * 不自己遍历实体池，直接读经济层每个日 tick 算好的结果：
   * 单看「2 座断供」没有意义，要看「总共 4 座里断了 2 座」，
   * 两个数的口径必须来自同一次统计，否则 HUD 上会出现 3/2 这种鬼数字。
   */
  supply(): { readonly blocked: number; readonly total: number } {
    return this.economy.logisticsStatsOf(this.city);
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
    // 路网也要复位：重放只做加法，上一局留下的挡板会继续堵路（见 CityRoads.reset 注释）
    this.roads.reset();
    const state = this.economy.state;
    for (let id = 0; id < state.capacity; id += 1) {
      if (state.alive[id] === 0) continue;
      if ((state.buildingCity[id] as number) !== this.city) continue;
      this.onPlaced(id, state.buildingTile[id] as number, state.buildingType[id] as number);
    }
  }

  /**
   * 把当前地图快照打成**分块存档**。
   *
   * 与 `economy.save()` 的区别：那份是权威状态（金库、人口、日期），
   * 这份只是地图层的读缓存（哪一格是什么、哪一格是哪栋楼）。
   * 两者的关系是「状态 + 快照」，读档时以状态为准，快照用来校验与快速呈现。
   */
  packWorld(): Uint8Array {
    return packChunks(splitChunks(this.cells, this.entityAt));
  }

  /** 地图快照的体积与块数，诊断面板用。 */
  worldArchiveInfo(bytes?: Uint8Array): { readonly chunks: number; readonly bytes: number } {
    const archive = bytes ?? this.packWorld();
    return { chunks: readDirectory(archive).directory.length, bytes: archive.length };
  }

  /**
   * 用分块存档回填投影。
   *
   * 返回 `true` 表示快照与经济层一致；返回 `false` 表示快照过期或损坏，
   * 此时**以经济层为准**重建投影 —— 快照是缓存，缓存永远不能覆盖真相。
   * 这条规则不能反过来：让快照去覆盖实体池，等于允许存档文件凭空造建筑。
   */
  restoreWorld(bytes: Uint8Array): boolean {
    let merged: { cells: Int8Array; entities: Int32Array };
    try {
      merged = mergeChunks(readAllChunks(bytes));
    } catch {
      this.rebuild();
      return false;
    }

    let mismatch = 0;
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      if ((merged.cells[tile] as number) !== (this.cells[tile] as number)) mismatch += 1;
      else if ((merged.entities[tile] as number) !== (this.entityAt[tile] as number)) mismatch += 1;
    }
    if (mismatch > 0) {
      this.rebuild();
      return false;
    }
    return true;
  }

  /** 开始一次流式加载演示：以市政厅为焦点，每帧加载 1 块。 */
  beginStreaming(): void {
    this.streamer = new ChunkStreamer(this.packWorld());
    this.streamer.configure({ radius: 1, budget: 1, unloadGraceFrames: 45 });
    this.streamer.focus(HUB_TILE);
  }

  /** 把流式加载的焦点挪到某个格子（2D 视图里跟着指针走）。 */
  focusAt(tile: number): void {
    this.streamer?.focus(tile);
  }

  /** 推进一步流式加载，返回是否发生了变化。 */
  streamStep(): boolean {
    if (this.streamer === null) return false;
    const result = this.streamer.step();
    return result.loaded > 0 || result.unloaded > 0;
  }

  streamStats(): {
    readonly enabled: boolean;
    readonly resident: number;
    readonly total: number;
    readonly loads: number;
    readonly unloads: number;
  } {
    const streamer = this.streamer;
    if (streamer === null) {
      return { enabled: false, resident: 0, total: CHUNKS_X * CHUNKS_Y, loads: 0, unloads: 0 };
    }
    return {
      enabled: true,
      resident: streamer.residentCount,
      total: streamer.chunkCount,
      loads: streamer.loadCount,
      unloads: streamer.unloadCount,
    };
  }

  /**
   * 存档：经济层字节 + 地图分块快照 + 缩略图预览。
   *
   * 三样东西分开存是有意的 —— 它们的失效方式不同：
   * - 经济层字节坏掉 → 读档失败，一切重来；
   * - 地图快照坏掉 → 只坏一块（`readAllChunks` 会跳过），投影还能从实体池重建；
   * - 预览图坏掉 → 只影响存档列表的缩略图，与玩法无关。
   * 打成一个不透明的 blob 就无法区分这三种情况。
   */
  saveToStorage(): boolean {
    try {
      const payload = {
        version: 2,
        economy: toBase64(this.economy.save()),
        world: toBase64(this.packWorld()),
        preview: this.minimap.toDataUrl(),
        savedAt: Date.now(),
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  loadFromStorage(): boolean {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as { economy?: string; world?: string; version?: number };
        if (typeof parsed.economy !== 'string') return false;
        this.economy.load(fromBase64(parsed.economy));
        // 读档是批量替换，增量回调收不到，必须全量重建
        this.rebuild();
        if (typeof parsed.world === 'string') {
          // 快照只用来验证投影；不一致时 restoreWorld 内部已经按实体池重建了
          const consistent = this.restoreWorld(fromBase64(parsed.world));
          if (!consistent) this.blockedNotice = '地图快照与存档不一致，已按实体池重建投影';
        }
        return true;
      }

      // 回退到 v1 老存档
      const legacy = localStorage.getItem(SAVE_KEY_V1);
      if (legacy === null) return false;
      this.economy.load(fromBase64(legacy));
      this.rebuild();
      return true;
    } catch {
      return false;
    }
  }

  hasSave(): boolean {
    try {
      return localStorage.getItem(SAVE_KEY) !== null || localStorage.getItem(SAVE_KEY_V1) !== null;
    } catch {
      return false;
    }
  }

  private placeRaw(col: number, row: number, defIndex: number): void {
    if (defIndex < 0) return;
    this.economy.applyCommand({ type: 'place-building', city: this.city, tile: indexOf(col, row), def: defIndex });
  }

  /** 建筑定义下标 → 格子类型。配置表里出现未知 key（比如 mod 加的建筑）时退化为空地。 */
  private cellOfDef(defIndex: number): CellKind {
    const key = this.table.buildings[defIndex]?.key;
    if (key === undefined) return Cell.Empty;
    return (KEY_CELL as Record<string, CellKind | undefined>)[key] ?? Cell.Empty;
  }

  private onPlaced(id: number, tile: number, defIndex: number): void {
    if (tile < 0 || tile >= TILE_COUNT) return;
    this.entityAt[tile] = id;
    const kind = this.cellOfDef(defIndex);
    this.cells[tile] = kind;
    // 挡板同时是路障：先改路网再绑建筑，否则这一帧查效率会读到旧图
    if (kind === Cell.Wall) this.roads.setWall(tile, true);
    this.roads.bindBuilding(id, tile);
  }

  private onRemoved(id: number, tile: number): void {
    this.roads.unbindBuilding(id);
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
    if (this.cells[tile] === Cell.Wall) this.roads.setWall(tile, false);
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
