import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Economy,
  TickScheduler,
  buildingIndexOf,
  DEFAULT_BUILDINGS,
  inflationRatio,
  nextPrice,
  MAX_PRICE_FACTOR,
  MIN_PRICE_FACTOR,
  RES_STRIDE,
  TREASURY_MAX,
} from '../dist/index.js';

const HOUSE = buildingIndexOf(DEFAULT_BUILDINGS, 'house');
const FARM = buildingIndexOf(DEFAULT_BUILDINGS, 'farm');
const POWER = buildingIndexOf(DEFAULT_BUILDINGS, 'powerplant');
const FACTORY = buildingIndexOf(DEFAULT_BUILDINGS, 'factory');

/** 建一个能自持的村子：3 住房 + 2 农田 + 1 电站，人口 20。 */
function village(options = {}) {
  const eco = new Economy({ entityCapacity: 256, cityCount: 1, seed: 42, ...options });
  eco.init({ population: [20], treasury: [500], stock: [[40, 10, 0, 0]] });
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push(eco.placeBuilding(0, i, HOUSE));
  for (let i = 0; i < 2; i += 1) ids.push(eco.placeBuilding(0, 10 + i, FARM));
  ids.push(eco.placeBuilding(0, 20, POWER));
  assert.ok(ids.every((id) => id >= 0), '初始建筑应全部建造成功');
  return { eco, ids };
}

test('价格：供给趋零不会指数爆炸', () => {
  const def = { key: 'food', label: '食物', basePrice: 5, elasticity: 0.9, targetStock: 60 };
  let price = def.basePrice;
  for (let i = 0; i < 200; i += 1) price = nextPrice(price, 0, 100, def, 0.15);
  assert.ok(price <= def.basePrice * MAX_PRICE_FACTOR + 1e-6, `价格应被钳制，实际 ${price}`);
  assert.ok(price >= def.basePrice * MIN_PRICE_FACTOR - 1e-6);
});

test('价格：供给远大于需求时不会归零', () => {
  const def = { key: 'wood', label: '木材', basePrice: 8, elasticity: 0.7, targetStock: 40 };
  let price = def.basePrice;
  for (let i = 0; i < 200; i += 1) price = nextPrice(price, 1e6, 1, def, 0.15);
  assert.ok(price >= def.basePrice * MIN_PRICE_FACTOR - 1e-6, `价格应不低于下界，实际 ${price}`);
});

test('生产：农田按效率产粮，输入不足按比例缩产', () => {
  const eco = new Economy({ entityCapacity: 32, cityCount: 1 });
  eco.init({ population: [0], treasury: [1000], stock: [[0, 0, 0, 0]] });
  const farm = eco.placeBuilding(0, 1, FARM);
  assert.ok(farm >= 0);

  // 无电力 → 输入不足，产出为 0
  eco.tickDays(1);
  assert.equal(eco.state.stockOf(0, 0), 0, '没有电力不应该产粮');

  // 给足电力，跑 1 天
  eco.state.setStock(0, 3, 100);
  eco.tickDays(1);
  const food = eco.state.stockOf(0, 0);
  assert.ok(food > 5.9 && food <= 6.01, `应产 6 单位食物，实际 ${food}`);
});

test('消费：人口吃粮，缺口比例正确写入', () => {
  const eco = new Economy({ entityCapacity: 16, cityCount: 1, foodPerCapita: 0.05 });
  eco.init({ population: [100], treasury: [0], stock: [[2, 0, 0, 0]] });
  eco.tickDays(1);
  assert.equal(eco.state.stockOf(0, 0), 0, '粮食应被吃光');
  const city = eco.getCity(0);
  assert.ok(city.starving, '缺粮应被标记');
  assert.ok(Math.abs(city.population - 100) < 30, '单日不应出现人口断崖');
});

test('人口：增长受住房容量钳制', () => {
  const eco = new Economy({ entityCapacity: 32, cityCount: 1 });
  eco.init({ population: [1], treasury: [10000], stock: [[1000, 1000, 1000, 1000]] });
  eco.applyCommand({ type: 'place-building', city: 0, tile: 1, def: HOUSE }); // capacity 10
  eco.applyCommand({ type: 'place-building', city: 0, tile: 2, def: FARM });
  eco.tickDays(2000);
  const pop = eco.state.cityPopulation[0];
  assert.ok(pop <= 10 + 1e-6, `人口不应超过住房容量 10，实际 ${pop}`);
});

test('税收：月末入账，税率与满意度打折', () => {
  const eco = new Economy({ entityCapacity: 16, cityCount: 1, taxRate: 0.1, incomePerCapita: 3 });
  eco.init({ population: [100], treasury: [0], stock: [[1000, 0, 0, 0]] });
  let months = 0;
  eco.bus.on('month-end', () => { months += 1; });
  eco.tickDays(29);
  assert.equal(months, 0, '第 29 天不应月结');
  eco.tickDays(1);
  assert.equal(months, 1, '第 30 天应月结一次');
  const treasury = eco.state.cityTreasury[0];
  // 100 人 × 3 × 0.1 × (0.5 + 满意度*0.5)，满意度约 0.5~0.7
  assert.ok(treasury >= 15 && treasury <= 40, `税收应落在合理区间，实际 ${treasury}`);
});

test('耐久：付不起维护费时效率下滑而不是瞬间归零', () => {
  const eco = new Economy({ entityCapacity: 16, cityCount: 1 });
  // 先给够造价，建好再把金库掏空 —— 这样测的是「付不起维护费」，不是「建不起」
  eco.init({ population: [0], treasury: [200], stock: [[0, 0, 0, 0]] });
  const id = eco.placeBuilding(0, 1, FARM);
  assert.ok(id >= 0, '农田应建造成功');
  // 直接清零：生产代码不应提供「掏空金库」的指令，测试走 state 是刻意绕过
  eco.state.cityTreasury[0] = 0;
  eco.tickDays(30);
  const eff = eco.state.buildingEfficiency[id];
  assert.ok(eff > 0 && eff < 1, `效率应逐步下滑而不是归零，实际 ${eff}`);
});

test('确定性：同样配置两次跑 5 年，逐字段一致', () => {
  const a = village();
  const b = village();
  a.eco.tickDays(360 * 5);
  b.eco.tickDays(360 * 5);
  assert.deepEqual(Array.from(a.eco.state.cityStock), Array.from(b.eco.state.cityStock));
  assert.deepEqual(Array.from(a.eco.state.cityPopulation), Array.from(b.eco.state.cityPopulation));
  assert.deepEqual(Array.from(a.eco.state.price), Array.from(b.eco.state.price));
  assert.equal(a.eco.state.cityTreasury[0], b.eco.state.cityTreasury[0]);
});

test('加速不改变结果：x1 分次推进 == x4 一次推进', () => {
  const a = village();
  const b = village();
  a.eco.setSpeed(1);
  b.eco.setSpeed(4);
  // x1：每次 2 秒 = 1 天，共 4 天
  for (let i = 0; i < 4; i += 1) a.eco.advance(2000);
  // x4：一次 2 秒 = 4 天
  b.eco.advance(2000);
  assert.deepEqual(Array.from(a.eco.state.cityStock), Array.from(b.eco.state.cityStock));
  assert.deepEqual(Array.from(a.eco.state.price), Array.from(b.eco.state.price));
  assert.equal(a.eco.state.tick, b.eco.state.tick);
});

test('调度器：backlog 超限跳帧并上报', () => {
  const s = new TickScheduler({ msPerDay: 16, maxTicksPerFrame: 8, maxBacklogTicks: 40 });
  let skipped = 0;
  for (let i = 0; i < 20; i += 1) {
    const { report } = s.advance(1000);
    skipped += report.skipped;
  }
  assert.ok(skipped > 0, '应发生跳帧');
});

test('调度器：单帧推进上限，不一次补完', () => {
  const s = new TickScheduler({ msPerDay: 16, maxTicksPerFrame: 8, maxBacklogTicks: 1000 });
  const { report, dayTicks } = s.advance(1000);
  assert.equal(dayTicks, 8, '单帧最多 8 个 tick');
  assert.ok(s.backlog > 0, '剩余部分应留在 backlog');
});

test('存档：往返一致，且读档后继续跑结果相同', () => {
  const a = village();
  a.eco.tickDays(100);
  const bytes = a.eco.save();
  assert.ok(bytes.byteLength > 100, `存档应有内容，实际 ${bytes.byteLength} 字节`);

  const b = village();
  b.eco.load(bytes);
  assert.deepEqual(Array.from(a.eco.state.cityStock), Array.from(b.eco.state.cityStock));
  assert.equal(a.eco.state.cityTreasury[0], b.eco.state.cityTreasury[0]);
  assert.equal(a.eco.state.tick, b.eco.state.tick);

  a.eco.tickDays(200);
  b.eco.tickDays(200);
  assert.deepEqual(Array.from(a.eco.state.cityStock), Array.from(b.eco.state.cityStock));
  assert.deepEqual(Array.from(a.eco.state.price), Array.from(b.eco.state.price));
});

test('存档：魔数不对时明确报错', () => {
  const eco = new Economy({ entityCapacity: 8, cityCount: 1 });
  assert.throws(() => eco.load(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), /魔数/);
});

test('墓碑：删除后槽位可复用，存活 id 不受影响', () => {
  const eco = new Economy({ entityCapacity: 8, cityCount: 1 });
  eco.init({ treasury: [10000] });
  const a = eco.placeBuilding(0, 1, HOUSE);
  const b = eco.placeBuilding(0, 2, HOUSE);
  assert.equal(a, 0);
  assert.equal(b, 1);

  assert.ok(eco.applyCommand({ type: 'remove-building', id: a }));
  assert.equal(eco.state.alive[a], 0);
  assert.equal(eco.state.alive[b], 1, '删除不应影响其他实体');

  const c = eco.placeBuilding(0, 3, HOUSE);
  assert.equal(c, a, '应复用被释放的槽位');
  assert.equal(eco.state.aliveBuildings, 2);
});

test('指令路径：place-building 通过事件回传实体 id', () => {
  const eco = new Economy({ entityCapacity: 8, cityCount: 1 });
  eco.init({ treasury: [1000] });
  let placed = -1;
  eco.bus.on('building-placed', (e) => { placed = e.id; });
  assert.ok(eco.applyCommand({ type: 'place-building', city: 0, tile: 5, def: HOUSE }));
  assert.equal(placed, 0, '事件应带回实体 id');
  assert.ok(eco.applyCommand({ type: 'remove-building', id: placed }));
});

test('指令校验：资金不足 / 格子占用 / 地形不可建', () => {
  const eco = new Economy({ entityCapacity: 8, cityCount: 1 });
  eco.init({ treasury: [10] });
  const warnings = [];
  eco.bus.on('warning', (w) => warnings.push(w.code));

  assert.equal(eco.applyCommand({ type: 'place-building', city: 0, tile: 1, def: HOUSE }), false);
  assert.ok(warnings.includes('insufficient-funds'));

  eco.applyCommand({ type: 'deposit', city: 0, amount: 1000 });
  assert.ok(eco.applyCommand({ type: 'place-building', city: 0, tile: 1, def: HOUSE }));
  assert.equal(eco.applyCommand({ type: 'place-building', city: 0, tile: 1, def: HOUSE }), false);
  assert.ok(warnings.includes('occupied'));

  eco.setTerrain({
    isBuildable: (tile) => tile !== 9,
    isUnderwater: () => false,
    slope: () => 0,
  });
  assert.equal(eco.applyCommand({ type: 'place-building', city: 0, tile: 9, def: HOUSE }), false);
  assert.ok(warnings.includes('not-buildable'));
});

test('陷阱：税率被钳制，负税率不会凭空造钱', () => {
  const eco = new Economy({ entityCapacity: 8, cityCount: 1 });
  const warnings = [];
  eco.bus.on('warning', (w) => warnings.push(w.code));
  eco.applyCommand({ type: 'set-tax', city: 0, rate: -1 });
  assert.equal(eco.state.cityTaxRate[0], 0);
  assert.ok(warnings.includes('tax-clamped'));
  eco.applyCommand({ type: 'set-tax', city: 0, rate: 5 });
  // Float32 存 0.6 会存成 0.6000000238418579，比较要带容差
  assert.ok(Math.abs(eco.state.cityTaxRate[0] - 0.6) < 1e-6);
});

test('陷阱：金库不会因入账过亿而回绕成负数', () => {
  const eco = new Economy({ entityCapacity: 8, cityCount: 1 });
  eco.init({ treasury: [0] });
  const warnings = [];
  eco.bus.on('bankrupt', (e) => warnings.push(e));
  // Int32 上限 2147483647：不钳制的话这里会变成负数，然后被判定为破产
  eco.applyCommand({ type: 'deposit', city: 0, amount: 3_000_000_000 });
  assert.equal(eco.state.cityTreasury[0], TREASURY_MAX);
  assert.ok(eco.state.cityTreasury[0] > 0, '金库必须保持正数');
  eco.tickDays(30);
  assert.equal(warnings.length, 0, '钱多不应触发破产事件');
});

test('通胀比：gdp 为 0 时不会除零', () => {
  assert.equal(inflationRatio(100, 0), Number.POSITIVE_INFINITY);
  assert.equal(inflationRatio(0, 0), 1);
  assert.equal(inflationRatio(100, 200), 0.5);
});

test('诊断：5 年后建筑与人口仍然存活，没有静默归零', () => {
  const { eco } = village();
  eco.tickDays(360 * 5);
  const diag = eco.getDiagnostics();
  assert.equal(diag.aliveBuildings, 6, '建筑不应自己消失');
  assert.ok(diag.totalPopulation > 0, `人口不应归零，实际 ${diag.totalPopulation}`);
  assert.ok(Number.isFinite(diag.gdp));
  assert.equal(diag.prices.length, 4);
  for (const p of diag.prices) assert.ok(p > 0 && Number.isFinite(p));
  void RES_STRIDE;
  void FACTORY;
});
