import test from 'node:test';
import assert from 'node:assert/strict';

import { CITY_KNOBS, CityKnobHost, KnobIds, createCityKnobPanel } from '../dist/knobs.js';
import { CITY_MINIMAP_SPEC, HUB_COLOR, MINIMAP_SCALE, BLOCKED_TINT } from '../dist/minimap-spec.js';
import { Cell, GRID_COLS, GRID_ROWS, TILE_COUNT, indexOf } from '../dist/city.js';
import { KnobPanel } from '@tabby/ui';

/**
 * 一个结构化的假仿真。
 *
 * 这里刻意不 new 真的 `CitySimulation`：那会把经济内核、路网、地形一起拉起来，
 * 于是「旋钮适配层」的测试就变成了「半个游戏的集成测试」。
 * 这一层要验的只有一件事：**id → 字段的映射对不对、写失败能不能被识别**。
 */
function makeSim() {
  const sim = {
    city: 0,
    irrigationUnit: 20,
    speedSet: [],
    economy: {
      speed: 1,
      msPerDay: 400,
      getCity: () => ({ taxRate: 0.12 }),
      setMsPerDay(value) {
        sim.economy.msPerDay = value;
      },
      applyCommand: () => true,
    },
    roads: {
      logistics: {
        curve: { freeDistance: 4, zeroDistance: 22 },
        setCurve(free, zero) {
          sim.roads.logistics.curve = { freeDistance: free, zeroDistance: zero };
        },
      },
    },
    setSpeed(speed) {
      sim.economy.speed = speed;
      sim.speedSet.push(speed);
    },
    setIrrigationUnit(unit) {
      sim.irrigationUnit = unit;
    },
  };
  return sim;
}

test('每个旋钮都能读到一个数（没有 id 拼错到静默失效）', () => {
  const host = new CityKnobHost(makeSim());
  for (const spec of CITY_KNOBS) {
    const value = host.read(spec.id);
    assert.notEqual(value, null, `旋钮 ${spec.id} 读不到值`);
    assert.equal(Number.isFinite(value), true, `旋钮 ${spec.id} 读到了非数字`);
  }
});

test('旋钮 id 唯一，且都在 KnobIds 里', () => {
  const ids = CITY_KNOBS.map((spec) => spec.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), Object.values(KnobIds).sort());
});

test('每个旋钮的区间合理（min < max，step 能走完区间）', () => {
  for (const spec of CITY_KNOBS) {
    assert.ok(spec.min < spec.max, `${spec.id} 区间反了`);
    assert.ok(spec.step > 0, `${spec.id} 步长必须为正`);
    const steps = (spec.max - spec.min) / spec.step;
    assert.ok(Math.abs(steps - Math.round(steps)) < 1e-9, `${spec.id} 的 min/max/step 不整除，滑不到终点`);
  }
});

test('速度写 3 会被吸附到 2：宿主报成功，面板靠回读发现不一致', () => {
  const sim = makeSim();
  const host = new CityKnobHost(sim);
  // 宿主这一层只知道「2 是合法速度」，写进去确实成功了 —— 它没撒谎
  assert.equal(host.write(KnobIds.speed, 3), true);
  assert.equal(host.read(KnobIds.speed), 2);

  // 而用户要的是 3。这一层看不出来，靠面板的回读兜底：
  // 「写成功」和「写得跟你要的一样」是两件事，必须分开判断。
  const panel = createCityKnobPanel(sim);
  const result = panel.apply(KnobIds.speed, 3);
  assert.equal(result.ok, false);
  assert.equal(panel.read(KnobIds.speed), 2);
});

test('速度写 4 生效', () => {
  const sim = makeSim();
  const host = new CityKnobHost(sim);
  assert.equal(host.write(KnobIds.speed, 4), true);
  assert.equal(host.read(KnobIds.speed), 4);
  assert.deepEqual(sim.speedSet, [4]);
});

test('税率写不进去时返回 false（内核拒绝）', () => {
  const sim = makeSim();
  sim.economy.applyCommand = () => false;
  const host = new CityKnobHost(sim);
  assert.equal(host.write(KnobIds.taxRate, 0.4), false);
});

test('改物流两个距离是各改各的，不会互相覆盖', () => {
  const sim = makeSim();
  const host = new CityKnobHost(sim);
  host.write(KnobIds.roadFree, 8);
  assert.deepEqual(sim.roads.logistics.curve, { freeDistance: 8, zeroDistance: 22 });
  host.write(KnobIds.roadZero, 12);
  assert.deepEqual(sim.roads.logistics.curve, { freeDistance: 8, zeroDistance: 12 });
});

test('未知 id 读 null、写 false（不抛）', () => {
  const host = new CityKnobHost(makeSim());
  assert.equal(host.read('nope'), null);
  assert.equal(host.write('nope', 1), false);
});

test('面板：写入后能从世界回读到真值', () => {
  const sim = makeSim();
  const panel = createCityKnobPanel(sim);
  const result = panel.apply(KnobIds.irrigation, 45);
  assert.equal(result.ok, true);
  assert.equal(sim.irrigationUnit, 45);
  assert.equal(panel.read(KnobIds.irrigation), 45);
});

test('面板：被钳制时滑块弹回真值而不是停在假值', () => {
  const sim = makeSim();
  const panel = new KnobPanel(CITY_KNOBS, new CityKnobHost(sim));
  const result = panel.apply(KnobIds.speed, 3);
  assert.equal(result.ok, false);
  assert.equal(panel.read(KnobIds.speed), 2);
});

test('小地图 spec 与城市网格一致', () => {
  assert.equal(CITY_MINIMAP_SPEC.cols, GRID_COLS);
  assert.equal(CITY_MINIMAP_SPEC.rows, GRID_ROWS);
  assert.equal(CITY_MINIMAP_SPEC.cols * CITY_MINIMAP_SPEC.rows, TILE_COUNT);
  assert.equal(CITY_MINIMAP_SPEC.scale, MINIMAP_SCALE);
});

test('调色板覆盖所有格子种类', () => {
  const max = Math.max(...Object.values(Cell));
  assert.ok(CITY_MINIMAP_SPEC.palette.length > max, '调色板长度不够，会读到 undefined 色');
  // 空地与建筑必须不同色，否则小地图上分不出哪里建了东西
  assert.notEqual(CITY_MINIMAP_SPEC.palette[Cell.Empty], CITY_MINIMAP_SPEC.palette[Cell.House]);
  assert.equal(CITY_MINIMAP_SPEC.emptyValue, Cell.Empty);
});

test('市政厅的针脚落在枢纽格上，颜色与建筑色不同', () => {
  assert.equal(CITY_MINIMAP_SPEC.pins.length, 1);
  const pin = CITY_MINIMAP_SPEC.pins[0];
  assert.equal(pin.tile, indexOf(0, 0));
  assert.equal(pin.color, HUB_COLOR);
  assert.notEqual(pin.color, CITY_MINIMAP_SPEC.palette[Cell.Empty]);
  // 断供色也不能等于任何正常格颜色，否则「断供」看不出来
  assert.equal(CITY_MINIMAP_SPEC.palette.includes(BLOCKED_TINT), false);
});
