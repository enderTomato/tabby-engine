import { EventBus } from '@tabby/core';
import { DEFAULT_BUILDINGS, DEFAULT_CONFIG, DEFAULT_RESOURCES, validateBuildings, validateResources } from './defs.js';
import { EconomyState } from './state.js';
import { TickScheduler, type GameSpeed } from './scheduler.js';
import { clamp, inflationRatio } from './price.js';
import {
  aggregate,
  gdpOf,
  moneySupplyOf,
  runConsumption,
  runEvents,
  runLogistics,
  runMaintenance,
  runMarket,
  runPopulation,
  runProduction,
  runTax,
  type SystemContext,
} from './systems.js';
import { decodeSave, encodeSave, SAVE_VERSION } from './save.js';
import {
  RES_STRIDE,
  TREASURY_MAX,
  TREASURY_MIN,
  type BuildingDef,
  type CitySnapshot,
  type EconomyCommand,
  type EconomyConfig,
  type EconomyDiagnostics,
  type EconomyEvents,
  type EconomyOptions,
  type ResourceDef,
  type TerrainQuery,
  type TickReport,
} from './types.js';

export interface EconomyInit {
  readonly population?: readonly number[];
  /** 初始库存，`[city][resource]`，缺省全部为 0。 */
  readonly stock?: readonly (readonly number[])[];
  readonly treasury?: readonly number[];
}

/**
 * 经济内核门面。
 *
 * 三条边界，靠代码结构而非口头约定保证：
 *
 * 1. 不 import 任何渲染 / 物理 / DOM —— `tsconfig` 的 `lib` 只有 ES2022，
 *    写 `window.` 会直接编译失败，不需要靠 review 拦。
 * 2. 时间从外部注入。`advance(realDeltaMs)` 是唯一入口，内部不读时钟；
 *    `clock` 可选，仅用于耗时统计，不给就是 0。
 * 3. 改世界只能走 `applyCommand`。没有 `addBuildingDirect` 之类的后门 ——
 *    一旦有，回放与多人同步就一定会在某个补丁里失效。
 */
export class Economy {
  readonly state: EconomyState;
  readonly bus: EventBus<EconomyEvents>;
  readonly buildings: readonly BuildingDef[];
  readonly resources: readonly ResourceDef[];
  readonly config: EconomyConfig;

  private readonly scheduler: TickScheduler;
  private readonly seed: number;
  private readonly clock: (() => number) | null;
  private terrain: TerrainQuery | null = null;

  private lastDayMs = 0;
  private lastMonthMs = 0;
  private lastTaxIncome = 0;
  private lastUpkeep = 0;
  private lastMonthTicks = 0;
  private lastYearTicks = 0;

  constructor(options: EconomyOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...withoutUndefined(options) };
    this.buildings = options.buildingDefs ?? DEFAULT_BUILDINGS;
    this.resources = options.resourceDefs ?? DEFAULT_RESOURCES;
    this.seed = this.config.seed;
    validateResources(this.resources);
    validateBuildings(this.buildings, this.resources.length);

    this.state = new EconomyState(this.config.entityCapacity, this.config.cityCount, this.resources.length);
    for (let city = 0; city < this.state.cityCount; city += 1) {
      this.state.cityTaxRate[city] = this.config.taxRate;
      this.state.citySatisfaction[city] = 0.5;
    }
    for (let res = 0; res < this.resources.length; res += 1) {
      this.state.price[res] = (this.resources[res] as ResourceDef).basePrice;
      this.state.priceTarget[res] = (this.resources[res] as ResourceDef).basePrice;
    }

    this.scheduler = new TickScheduler({
      daysPerMonth: this.config.daysPerMonth,
      monthsPerYear: this.config.monthsPerYear,
    });
    this.bus = new EventBus<EconomyEvents>();
    this.clock = options.clock ?? null;
  }

  /** 注入初始人口/库存/金库。只在初始化与「新开一局」时调用。 */
  init(data: EconomyInit): void {
    const pop = data.population ?? [];
    for (let city = 0; city < this.state.cityCount && city < pop.length; city += 1) {
      this.state.cityPopulation[city] = Math.max(0, Math.round(pop[city] as number));
    }
    const stock = data.stock ?? [];
    for (let city = 0; city < this.state.cityCount && city < stock.length; city += 1) {
      const row = stock[city] ?? [];
      for (let res = 0; res < this.resources.length && res < row.length; res += 1) {
        this.state.cityStock[city * RES_STRIDE + res] = Math.max(0, row[res] as number);
      }
    }
    const treasury = data.treasury ?? [];
    for (let city = 0; city < this.state.cityCount && city < treasury.length; city += 1) {
      this.state.cityTreasury[city] = Math.round(treasury[city] as number);
    }
    aggregate(this.context());
    this.state.clearScratch();
  }

  /** 地形只读查询。传 null 表示「无地形约束」（测试里常用）。 */
  setTerrain(query: TerrainQuery | null): void {
    this.terrain = query;
  }

  get speed(): GameSpeed {
    return this.scheduler.currentSpeed;
  }

  setSpeed(speed: GameSpeed): void {
    this.scheduler.setSpeed(speed);
  }

  get backlog(): number {
    return this.scheduler.backlog;
  }

  /**
   * 唯一的时间入口。
   *
   * 返回的 `TickReport` 里 `monthTicks` / `yearTicks` 是「本帧内跨过了几次月末/年末」，
   * 不是累计值 —— 调用方通常只在 >0 时刷新 UI。
   */
  advance(realDeltaMs: number): TickReport {
    const { report, dayTicks } = this.scheduler.advance(realDeltaMs);
    if (dayTicks === 0 && report.skipped === 0) {
      // 注意这里不能返回上一帧的 monthTicks —— 调用方看见 1 会以为又过了一个月
      return { dayTicks: 0, monthTicks: 0, yearTicks: 0, skipped: 0 };
    }

    this.lastMonthTicks = 0;
    this.lastYearTicks = 0;

    if (report.skipped > 0) {
      // 跳帧：推进日期但**不结算**。玩家的观感是「切后台回来过了几天」，
      // 而不是「回来发现破产了」。代价是这几天没有产出，比卡死好。
      this.advanceDateOnly(report.skipped);
      this.bus.emit('tick-skipped', { count: report.skipped, day: this.state.day });
    }

    for (let i = 0; i < dayTicks; i += 1) this.runDay();

    return {
      dayTicks,
      monthTicks: this.lastMonthTicks,
      yearTicks: this.lastYearTicks,
      skipped: report.skipped,
    };
  }

  /** 绕过真实时间直接跑 N 个日 tick。测试、服务端权威模拟、调试控制台都用它。 */
  tickDays(days: number): void {
    const n = Math.max(0, Math.floor(days));
    this.lastMonthTicks = 0;
    this.lastYearTicks = 0;
    for (let i = 0; i < n; i += 1) this.runDay();
  }

  /** 指令是唯一的状态变更入口。返回 false 表示被拒绝，原因通过 warning 事件发出。 */
  applyCommand(command: EconomyCommand): boolean {
    switch (command.type) {
      case 'place-building':
        return this.placeBuilding(command.city, command.tile, command.def) >= 0;
      case 'remove-building':
        return this.removeBuilding(command.id);
      case 'set-tax': {
        if (!this.validCity(command.city)) return this.reject('bad-city', `城市下标 ${command.city} 越界`);
        const rate = clamp(command.rate, 0, 0.6);
        if (rate !== command.rate) {
          this.reject('tax-clamped', `税率 ${command.rate} 已钳制到 ${rate}（上限 0.6，防止负税收）`);
        }
        this.state.cityTaxRate[command.city] = rate;
        return true;
      }
      case 'deposit': {
        if (!this.validCity(command.city)) return this.reject('bad-city', `城市下标 ${command.city} 越界`);
        // 只接受正数：负数会把金库打成负值，「破产」这类机制必须走维护费那条路径，
        // 否则会有人用 deposit(-1e9) 去"测试"破产，然后真的把存档写坏
        if (!(command.amount > 0)) return this.reject('bad-amount', `存款金额必须为正，收到 ${command.amount}`);
        this.addTreasury(command.city, command.amount);
        return true;
      }
      default: {
        // 穷尽检查：新增指令类型却忘了实现，编译期就会在这里报错
        const never: never = command;
        return this.reject('unknown-command', `未知指令 ${JSON.stringify(never)}`);
      }
    }
  }

  /** 放置建筑。返回新实体 id，失败返回 -1。 */
  placeBuilding(city: number, tile: number, defIndex: number): number {
    if (!this.validCity(city)) {
      this.reject('bad-city', `城市下标 ${city} 越界`);
      return -1;
    }
    if (defIndex < 0 || defIndex >= this.buildings.length) {
      this.reject('bad-def', `建筑定义下标 ${defIndex} 越界`);
      return -1;
    }
    if (this.terrain !== null && tile >= 0) {
      if (!this.terrain.isBuildable(tile)) {
        this.reject('not-buildable', `格子 ${tile} 不可建造`);
        return -1;
      }
      if (this.terrain.isUnderwater(tile)) {
        this.reject('underwater', `格子 ${tile} 在水下`);
        return -1;
      }
    }
    if (this.occupied(tile)) {
      this.reject('occupied', `格子 ${tile} 已被占用`);
      return -1;
    }

    const def = this.buildings[defIndex] as BuildingDef;
    const treasury = this.state.cityTreasury[city] as number;
    if (treasury < def.buildCost) {
      this.reject('insufficient-funds', `金库 ${treasury} < 造价 ${def.buildCost}`);
      return -1;
    }

    const id = this.state.allocate(defIndex, city, tile);
    if (id < 0) {
      this.reject('pool-full', `实体池已满（${this.state.capacity}）`);
      return -1;
    }
    this.state.cityTreasury[city] = treasury - def.buildCost;
    aggregate(this.context());
    this.bus.emit('building-placed', { id, city, tile, def: defIndex });
    return id;
  }

  /** 拆除建筑，返还 50% 造价（向下取整）。库存留在城市，不跟随建筑消失。 */
  removeBuilding(id: number): boolean {
    if (id < 0 || id >= this.state.capacity || this.state.alive[id] === 0) {
      return this.reject('no-such-building', `实体 ${id} 不存在或已拆除`);
    }
    const def = this.buildings[this.state.buildingType[id] as number];
    const city = this.state.buildingCity[id] as number;
    if (def !== undefined && this.validCity(city)) {
      this.addTreasury(city, Math.floor(def.buildCost * 0.5));
    }
    this.state.destroy(id);
    aggregate(this.context());
    this.bus.emit('building-removed', { id, city, def: this.state.buildingType[id] as number });
    return true;
  }

  getCity(city: number): CitySnapshot | null {
    if (!this.validCity(city)) return null;
    return {
      id: city,
      population: this.state.cityPopulation[city] as number,
      taxRate: this.state.cityTaxRate[city] as number,
      satisfaction: this.state.citySatisfaction[city] as number,
      treasury: this.state.cityTreasury[city] as number,
      housing: this.state.cityHousing[city] as number,
      jobs: this.state.cityJobs[city] as number,
      employed: this.state.cityEmployed[city] as number,
      starving: (this.state.cityFoodShortage[city] as number) > 0.05,
    };
  }

  getDiagnostics(): EconomyDiagnostics {
    const ctx = this.context();
    const gdp = gdpOf(ctx);
    const moneySupply = moneySupplyOf(this.state);
    let population = 0;
    for (let city = 0; city < this.state.cityCount; city += 1) {
      population += this.state.cityPopulation[city] as number;
    }
    const prices: number[] = [];
    for (let res = 0; res < this.resources.length; res += 1) prices.push(this.state.price[res] as number);

    return {
      day: this.state.day,
      month: this.state.month,
      year: this.state.year,
      tick: this.state.tick,
      aliveBuildings: this.state.aliveBuildings,
      totalPopulation: population,
      moneySupply,
      gdp,
      inflationRatio: inflationRatio(moneySupply, gdp),
      lastDayMs: this.lastDayMs,
      lastMonthMs: this.lastMonthMs,
      prices,
    };
  }

  save(): Uint8Array {
    return encodeSave(this.state, this.seed, []);
  }

  /** 读档：状态整体替换。种子随时间变化以外的随机源都要一并恢复，否则回放对不上。 */
  load(bytes: Uint8Array): void {
    const { state, header } = decodeSave(bytes);
    if (state.capacity !== this.state.capacity || state.cityCount !== this.state.cityCount) {
      throw new Error(
        `[tabby/economy] 存档容量 ${state.capacity}/${state.cityCount} 与当前实例 ` +
          `${this.state.capacity}/${this.state.cityCount} 不匹配，请在创建实例前读档`,
      );
    }
    if (header.version > SAVE_VERSION) {
      throw new Error(`[tabby/economy] 存档版本 ${header.version} 过新`);
    }
    for (let i = 0; i < state.cityStock.length; i += 1) {
      this.state.cityStock[i] = state.cityStock[i] as number;
    }
    this.state.alive.set(state.alive);
    this.state.buildingType.set(state.buildingType);
    this.state.buildingCity.set(state.buildingCity);
    this.state.buildingTile.set(state.buildingTile);
    this.state.buildingEfficiency.set(state.buildingEfficiency);
    this.state.cityPopulation.set(state.cityPopulation);
    this.state.cityTaxRate.set(state.cityTaxRate);
    this.state.citySatisfaction.set(state.citySatisfaction);
    this.state.cityTreasury.set(state.cityTreasury);
    this.state.price.set(state.price);
    this.state.priceTarget.set(state.priceTarget);
    this.state.day = state.day;
    this.state.month = state.month;
    this.state.year = state.year;
    this.state.tick = state.tick;
    for (const warning of header.warnings) this.bus.emit('warning', { code: 'save-warning', message: warning });
    aggregate(this.context());
    this.state.clearScratch();
  }

  private runDay(): void {
    const started = this.clock?.() ?? 0;
    const ctx = this.context();

    this.state.tick += 1;
    this.state.clearScratch();

    // 固定 8 步，见 systems.ts 顶部注释
    aggregate(ctx);
    runProduction(ctx);
    runConsumption(ctx);
    runLogistics(ctx);
    runMarket(ctx);
    runPopulation(ctx);
    const tax = runTax(ctx, this.config.daysPerMonth);
    const upkeep = runMaintenance(ctx, this.config.daysPerMonth);
    const outcome = runEvents(ctx, this.config.daysPerMonth);

    this.lastTaxIncome = tax.taxIncome;
    this.lastUpkeep = upkeep.upkeep;

    const isMonthEnd = this.state.day === this.config.daysPerMonth;
    if (isMonthEnd) {
      this.lastMonthTicks += 1;
      this.bus.emit('month-end', {
        year: this.state.year,
        month: this.state.month,
        taxIncome: tax.taxIncome,
        upkeep: upkeep.upkeep,
        treasury: this.state.cityTreasury[0] as number,
      });
      for (const city of outcome.bankruptcies) {
        this.bus.emit('bankrupt', { city, treasury: this.state.cityTreasury[city] as number });
      }
    }
    for (const famine of outcome.famines) {
      this.bus.emit('famine', famine);
    }
    for (const boom of outcome.booms) {
      this.bus.emit('boom', boom);
    }

    this.bus.emit('day-tick', { day: this.state.day, month: this.state.month, year: this.state.year });

    // 日期推进放在所有系统之后：runTax / runMaintenance 靠 `day === daysPerMonth` 判断月末，
    // 先推进会让月末结算永远差一天。
    this.state.day += 1;
    if (this.state.day > this.config.daysPerMonth) {
      this.state.day = 1;
      this.state.month += 1;
      if (this.state.month > this.config.monthsPerYear) {
        this.state.month = 1;
        this.state.year += 1;
        this.lastYearTicks += 1;
        this.bus.emit('year-end', {
          year: this.state.year,
          population: this.state.cityPopulation[0] as number,
          gdp: gdpOf(ctx),
        });
      }
    }

    if (this.clock !== null) {
      const elapsed = this.clock() - started;
      this.lastDayMs = elapsed;
      if (isMonthEnd) this.lastMonthMs = elapsed;
    }
  }

  private advanceDateOnly(days: number): void {
    for (let i = 0; i < days; i += 1) {
      this.state.day += 1;
      if (this.state.day > this.config.daysPerMonth) {
        this.state.day = 1;
        this.state.month += 1;
        if (this.state.month > this.config.monthsPerYear) {
          this.state.month = 1;
          this.state.year += 1;
        }
      }
    }
    this.state.tick += days;
  }

  private context(): SystemContext {
    return {
      state: this.state,
      buildings: this.buildings,
      resources: this.resources,
      config: this.config,
    };
  }

  /**
   * 金库写入的唯一入口，负责防溢出。
   *
   * `cityTreasury` 是 Int32Array：超过 2,147,483,647 会**静默回绕成负数**，
   * 而 `runEvents` 把负金库判定为破产。也就是说「钱太多」会触发「破产」——
   * 这个 bug 的触发条件在正常玩法里很难遇到，但修改器、通胀调参失误、
   * 或者存档跨设备同步时的重复入账都能碰到。上限留 1500 万的安全余量。
   */
  private addTreasury(city: number, delta: number): void {
    const next = (this.state.cityTreasury[city] as number) + Math.round(delta);
    this.state.cityTreasury[city] = clamp(next, TREASURY_MIN, TREASURY_MAX);
  }

  private validCity(city: number): boolean {
    return Number.isInteger(city) && city >= 0 && city < this.state.cityCount;
  }

  private occupied(tile: number): boolean {
    if (tile < 0) return false;
    for (let id = 0; id < this.state.capacity; id += 1) {
      if (this.state.alive[id] === 0) continue;
      if ((this.state.buildingTile[id] as number) === tile) return true;
    }
    return false;
  }

  private reject(code: string, message: string): false {
    this.bus.emit('warning', { code, message });
    return false;
  }

  /** 上一帧税收/维护费，供 UI 直接显示，不用自己盯 month-end 事件。 */
  get lastMonthSummary(): { readonly tax: number; readonly upkeep: number } {
    return { tax: this.lastTaxIncome, upkeep: this.lastUpkeep };
  }
}

/** EconomyConfig 全字段 readonly，Pick 出来也要去掉修饰符才能逐项赋值。 */
type ConfigDraft = { -readonly [K in keyof EconomyConfig]: EconomyConfig[K] };

function withoutUndefined(options: EconomyOptions): Partial<ConfigDraft> {
  const out: Partial<ConfigDraft> = {};
  if (options.entityCapacity !== undefined) out.entityCapacity = options.entityCapacity;
  if (options.cityCount !== undefined) out.cityCount = options.cityCount;
  if (options.seed !== undefined) out.seed = options.seed;
  if (options.taxRate !== undefined) out.taxRate = options.taxRate;
  if (options.foodPerCapita !== undefined) out.foodPerCapita = options.foodPerCapita;
  if (options.incomePerCapita !== undefined) out.incomePerCapita = options.incomePerCapita;
  if (options.daysPerTick !== undefined) out.daysPerTick = options.daysPerTick;
  if (options.daysPerMonth !== undefined) out.daysPerMonth = options.daysPerMonth;
  if (options.monthsPerYear !== undefined) out.monthsPerYear = options.monthsPerYear;
  return out;
}
