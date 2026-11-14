import test from 'node:test';
import assert from 'node:assert/strict';

import { Economy, buildingIndexOf, DEFAULT_BUILDINGS, RES_STRIDE } from '../dist/index.js';

const HOUSE = buildingIndexOf(DEFAULT_BUILDINGS, 'house');
const FARM = buildingIndexOf(DEFAULT_BUILDINGS, 'farm');
const POWERPLANT = buildingIndexOf(DEFAULT_BUILDINGS, 'powerplant');
const FOOD = 0;
const POWER = 3;

/** 3 住房 + 1 农田 + 1 电站，人口 10，初始食物 20，便于观察产量差异。 */
function farmVillage(logistics) {
  const eco = new Economy({ entityCapacity: 128, cityCount: 1, seed: 7, logistics });
  eco.init({ population: [10], treasury: [1000], stock: [[20, 0, 0, 0]] });
  for (let i = 0; i < 3; i += 1) eco.placeBuilding(0, i, HOUSE);
  const farmId = eco.placeBuilding(0, 10, FARM);
  const plantId = eco.placeBuilding(0, 20, POWERPLANT);
  assert.ok(farmId >= 0 && plantId >= 0, '农田/电站应放置成功');
  return eco;
}

function foodOf(eco) {
  return eco.state.stockOf(0, FOOD);
}

function runDays(eco, days) {
  eco.tickDays(days);
  return eco.getCity(0);
}

test('物流：不传 provider 时行为与之前完全一致（满效率）', () => {
  const eco = farmVillage(null);
  const before = foodOf(eco);
  runDays(eco, 5);
  const after = foodOf(eco);
  assert.ok(after > before, `农田应正常产出：${before} → ${after}`);
});

test('物流：efficiencyOf 返回 0 时农田停产', () => {
  const full = farmVillage(null);
  runDays(full, 5);
  const fullStock = foodOf(full);

  const blocked = farmVillage({ efficiencyOf: () => 0 });
  runDays(blocked, 5);
  const blockedStock = foodOf(blocked);

  assert.ok(blockedStock < fullStock, `断供后库存应更少：通畅 ${fullStock} vs 断供 ${blockedStock}`);
  // 断供后农田不产，食物只减不增（人口每天吃 0.5）
  assert.ok(blockedStock <= 20 + 1e-4, `断供时农田不该产出，库存 ${blockedStock} 超过初始 20`);
});

test('物流：efficiencyOf 返回 0.5 时产量约为一半', () => {
  const full = farmVillage(null);
  runDays(full, 5);
  const fullProduced = foodOf(full) - 20;

  const half = farmVillage({ efficiencyOf: () => 0.5 });
  runDays(half, 5);
  const halfProduced = foodOf(half) - 20;

  assert.ok(fullProduced > 0, '基准组应有产出');
  const ratio = halfProduced / fullProduced;
  assert.ok(ratio > 0.3 && ratio < 0.7, `半效率下产量比 ${ratio.toFixed(2)} 应接近 0.5`);
});

test('物流：只有农田断供时产量减半而不是全停', () => {
  const eco = new Economy({ entityCapacity: 128, cityCount: 1, seed: 7 });
  eco.init({ population: [10], treasury: [500], stock: [[20, 0, 0, 0]] });
  eco.placeBuilding(0, 0, FARM);
  eco.placeBuilding(0, 10, POWERPLANT);
  const farm = 0;
  const plant = 1;

  eco.setLogistics({ efficiencyOf: (id) => (id === farm ? 1 : 0) });
  const beforePower = eco.state.stockOf(0, POWER);
  eco.tickDays(3);
  assert.ok(eco.state.stockOf(0, POWER) <= beforePower + 1e-4, '电站断供后不该产电');

  eco.setLogistics({ efficiencyOf: (id) => (id === plant ? 1 : 0) });
  const beforeFood = eco.state.stockOf(0, FOOD);
  eco.tickDays(3);
  assert.ok(foodOf(eco) < beforeFood, '农田断供后食物应下降');
});

test('物流：系数被钳制到 [0,1]，非法值不会放大产量', () => {
  const full = farmVillage(null);
  runDays(full, 5);
  const fullStock = foodOf(full);

  const weird = farmVillage({ efficiencyOf: () => 5 });
  runDays(weird, 5);
  assert.equal(foodOf(weird), fullStock, '系数 > 1 必须钳到 1，否则物流成了加速器');

  const negative = farmVillage({ efficiencyOf: () => -3 });
  runDays(negative, 5);
  assert.ok(foodOf(negative) <= 20 + 1e-4, '负系数必须钳到 0');

  const nan = farmVillage({ efficiencyOf: () => NaN });
  runDays(nan, 5);
  assert.ok(Number.isFinite(foodOf(nan)), `NaN 系数不能污染库存，当前 ${foodOf(nan)}`);
  assert.ok(foodOf(nan) <= 20 + 1e-4, 'NaN 系数按 0 处理');
});

test('物流：只统计有产出的建筑，住宅断供不触发事件', () => {
  const events = [];
  const eco = farmVillage({ efficiencyOf: () => 0 });
  eco.bus.on('logistics-blocked', (e) => events.push(e));

  // 有产出的是农田 + 电站（2 个），全部断供 → 应当触发
  runDays(eco, 2);
  assert.ok(events.length > 0, '全部生产建筑断供应当发事件');
  assert.equal(events[0].total, 2, '总数只算农田 + 电站，3 栋住宅不计入');
  assert.equal(events[0].blocked, 2);
});

test('物流：一半生产建筑断供（1/2）刚好达到阈值，1/3 不触发', () => {
  // 建筑 id：0/1/2 住宅，3 农田，4 电站
  // 2 个生产建筑，断 1 个 → blocked*2 === total，按「>=」判定应当触发
  const two = farmVillage({ efficiencyOf: (id) => (id === 3 ? 1 : 0) });
  const twoEvents = [];
  two.bus.on('logistics-blocked', (e) => twoEvents.push(e));
  two.tickDays(2);
  assert.ok(twoEvents.length > 0, '2 个里断 1 个达到半数阈值');
  assert.equal(twoEvents[0].total, 2);

  // 3 个生产建筑（再加一个电站，id 5），其中 2 个断供其实也超半数了，
  // 所以这里只让新增的那个通，另两个断 → 2/3 仍触发；改成只断 1 个：
  // 农田 + 两个电站，只有电站（4）断 → 1/3 不该触发
  const three = farmVillage({ efficiencyOf: (id) => (id === 4 ? 0 : 1) });
  const extra = three.placeBuilding(0, 30, POWERPLANT);
  assert.equal(extra, 5, '新电站应分配到 id 5');
  const threeEvents = [];
  three.bus.on('logistics-blocked', (e) => threeEvents.push(e));
  three.tickDays(2);
  assert.equal(threeEvents.length, 0, '3 个里断 1 个不该报「半数以上断供」');
});

test('物流：不是每个 tick 都发事件（每天一次）', () => {
  const events = [];
  const eco = farmVillage({ efficiencyOf: () => 0 });
  eco.bus.on('logistics-blocked', (e) => events.push(e));
  runDays(eco, 10);
  assert.ok(events.length <= 10, `10 天不该超过 10 次事件，实际 ${events.length}`);
  assert.ok(events.length >= 5, `每天都在断供，应该天天报，实际 ${events.length}`);
});

test('物流：运行时替换 provider 立即生效', () => {
  const eco = farmVillage(null);
  runDays(eco, 3);
  const before = foodOf(eco);

  eco.setLogistics({ efficiencyOf: () => 0 });
  runDays(eco, 3);
  const after = foodOf(eco);

  // 断供后增长应该停止（食物还被人口消耗，所以是下降）
  assert.ok(after < before, `切换为断供后库存应下降：${before} → ${after}`);
});

test('物流：provider 收到的 buildingId 与 city 是真实值，且每建筑每天只问一次', () => {
  const seen = [];
  const eco = farmVillage({ efficiencyOf: (id, city) => {
    seen.push([id, city]);
    return 1;
  }});
  runDays(eco, 1);
  assert.ok(seen.length > 0, 'provider 应被调用');
  for (const [id, city] of seen) {
    assert.ok(id >= 0 && id < 128, `建筑 id 越界：${id}`);
    assert.equal(city, 0);
  }
  // 农田 + 电站 = 2 个有产出的建筑，住宅不该被问（它们不跑生产）
  assert.equal(seen.length, 2, `每天应只问 2 次，实际 ${seen.length} 次`);
  const ids = seen.map(([id]) => id).sort((a, b) => a - b);
  assert.deepEqual(ids, [3, 4], '应当正好是农田与电站');
});

test('物流：库存索引跨城市不会串味（city 1 断供不影响 city 0）', () => {
  const eco = new Economy({ entityCapacity: 128, cityCount: 2, seed: 7 });
  eco.init({
    population: [10, 10],
    treasury: [500, 500],
    stock: [[20, 0, 0, 0], [20, 0, 0, 0]],
  });
  eco.placeBuilding(0, 0, FARM);
  eco.placeBuilding(0, 10, POWERPLANT);
  eco.placeBuilding(1, 0, FARM);
  eco.placeBuilding(1, 10, POWERPLANT);

  eco.setLogistics({ efficiencyOf: (id, city) => (city === 1 ? 0 : 1) });
  eco.tickDays(3);

  assert.ok(eco.state.cityStock[0 * RES_STRIDE + FOOD] > 20, 'city 0 应正常产出');
  assert.ok(eco.state.cityStock[1 * RES_STRIDE + FOOD] < 20, 'city 1 应断供减产');
});
