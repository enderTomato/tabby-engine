import test from 'node:test';
import assert from 'node:assert/strict';
import { LiquidSystem } from '../dist/index.js';
import { PhysicsWorld } from '../dist/api/public.js';

const BOUNDS = { min: { x: -12, y: 0, z: -12 }, max: { x: 12, y: 14, z: 12 } };

function makeLiquid(overrides = {}) {
  return new LiquidSystem({
    originX: 0,
    originZ: 0,
    cellSize: 1,
    cols: 8,
    rows: 8,
    maxDepth: 2,
    ...overrides,
  });
}

test('液面：水从高处流向低处', () => {
  const liquid = makeLiquid();
  // 左半边注水，右半边干
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      liquid.depth[row * 8 + col] = 1.0;
    }
  }
  const before = liquid.getHeightAt(7.5, 3.5);
  assert.equal(before, 0, '右侧初始是干的');

  for (let i = 0; i < 240; i += 1) liquid.step(1 / 60);

  const left = liquid.getHeightAt(1.5, 3.5);
  const right = liquid.getHeightAt(7.5, 3.5);
  assert.ok(right > 0.05, `水应该流到右侧，实际 ${right}`);
  assert.ok(right > before);
  // 右侧靠近边界（col 7 的 +x 邻居越界），水位应低于左侧
  assert.ok(right < left, `远端应比近端浅：left=${left} right=${right}`);
});

test('液面：无溢出时总水量守恒', () => {
  const liquid = makeLiquid({ maxDepth: 10 });
  for (let i = 0; i < 32; i += 1) liquid.depth[i] = 0.8;
  const before = liquid.totalVolume;
  for (let i = 0; i < 300; i += 1) liquid.step(1 / 60);
  const after = liquid.totalVolume;
  const drift = Math.abs(after - before) / before;
  assert.ok(drift < 0.02, `体积漂移 ${(drift * 100).toFixed(2)}%，管道模型不该凭空造水`);
});

test('液面：大 dt 自动切子步，不会把水炸到全图', () => {
  const liquid = makeLiquid({ maxDepth: 10 });
  liquid.depth[4 * 8 + 4] = 1.5;
  // 模拟后台切回来那一帧：dt = 1 秒
  liquid.step(1.0);
  for (let i = 0; i < liquid.depth.length; i += 1) {
    const d = liquid.depth[i];
    assert.ok(Number.isFinite(d), `第 ${i} 格出现 NaN`);
    assert.ok(d >= 0, `第 ${i} 格出现负深度 ${d}`);
    assert.ok(d <= 1.5 + 1e-6, `第 ${i} 格深度 ${d} 超过总水量，说明数值爆炸了`);
  }
});

test('液面：CFL 上界随水深变化', () => {
  const liquid = makeLiquid({ cellSize: 1, maxDepth: 10 });
  assert.equal(liquid.cflLimit(), Infinity, '干网格没有 CFL 限制');
  liquid.depth[0] = 0.25;
  // l / sqrt(g*h) = 1 / sqrt(9.8*0.25) ≈ 0.639
  const limit = liquid.cflLimit();
  assert.ok(limit > 0.6 && limit < 0.66, `CFL 上界 ${limit} 不符合公式`);
});

test('液面：地形高处水会流走（边界条件生效）', () => {
  const liquid = makeLiquid({ maxDepth: 10 });
  // 右半边是高地
  for (let row = 0; row < 8; row += 1) {
    for (let col = 4; col < 8; col += 1) liquid.terrain[row * 8 + col] = 3;
  }
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 4; col += 1) liquid.depth[row * 8 + col] = 1;
  }
  for (let i = 0; i < 240; i += 1) liquid.step(1 / 60);

  // 高地不该积水：水面高度没超过地形顶部
  for (let row = 0; row < 8; row += 1) {
    for (let col = 4; col < 8; col += 1) {
      const d = liquid.depth[row * 8 + col];
      assert.ok(d < 0.05, `高地 (${col},${row}) 积了 ${d} 米水`);
    }
  }
  // 但低处的水也不能凭空消失（没超过高地对面的边界）
  assert.ok(liquid.totalVolume > 10, `总水量 ${liquid.totalVolume}，水不应被高地吃掉`);
});

test('液面：水源按流量注水，关阀后停止', () => {
  const liquid = makeLiquid({ maxDepth: 10 });
  liquid.addSource({ id: 'tap', x: 3.5, z: 3.5, rate: 2 });
  assert.equal(liquid.getSources().length, 1);

  for (let i = 0; i < 60; i += 1) liquid.step(1 / 60);
  const afterOneSecond = liquid.totalVolume;
  assert.ok(afterOneSecond > 1.5, `1 秒应注入约 2 立方米，实际 ${afterOneSecond}`);

  liquid.setFlowRate('tap', 0);
  const frozen = liquid.totalVolume;
  for (let i = 0; i < 60; i += 1) liquid.step(1 / 60);
  const later = liquid.totalVolume;
  assert.ok(Math.abs(later - frozen) < 0.2, `关阀后水量不该继续涨：${frozen} → ${later}`);

  assert.equal(liquid.removeSource('tap'), true);
  assert.equal(liquid.removeSource('tap'), false);
});

test('液面：超出 maxDepth 触发溢出回调', () => {
  const liquid = makeLiquid({ maxDepth: 0.5 });
  const overflows = [];
  liquid.onOverflow = (o) => overflows.push(o);
  liquid.depth[0] = 5;
  liquid.step(1 / 60);
  assert.equal(liquid.getHeightAt(0.5, 0.5), 0.5, '深度应被钳到 maxDepth');
  assert.ok(overflows.length > 0, '应触发溢出回调');
  assert.ok(overflows[0].volume > 0);
});

test('液面：存档往返一致', () => {
  const a = makeLiquid({ maxDepth: 2 });
  for (let i = 0; i < a.depth.length; i += 1) a.depth[i] = (i % 7) * 0.2;
  const blob = a.serialize();

  const b = makeLiquid({ maxDepth: 2 });
  b.deserialize(blob);
  for (let i = 0; i < a.depth.length; i += 1) {
    const diff = Math.abs(a.depth[i] - b.depth[i]);
    assert.ok(diff < 1e-4, `第 ${i} 格误差 ${diff}`);
  }
  assert.equal(blob.length, a.cellCount * 2, 'Uint16 归一化存储');
});

test('液面：存档长度不符时报错而不是静默错位', () => {
  const liquid = makeLiquid();
  assert.throws(() => liquid.deserialize(new Uint8Array(10)), /长度不符/);
});

test('液面：世界坐标查询越界返回 0 而不是越界读', () => {
  const liquid = makeLiquid();
  assert.equal(liquid.getHeightAt(-5, 0), 0);
  assert.equal(liquid.getHeightAt(100, 100), 0);
  assert.equal(liquid.getSurfaceAt(-1, -1), 0);
  assert.equal(liquid.indexAt(-0.1, 0), -1);
  assert.equal(liquid.indexAt(0.1, 0), 0);
});

test('液面：接入世界后随 step 一起推进，溢出走事件', () => {
  const world = new PhysicsWorld({
    bounds: BOUNDS,
    liquid: { originX: -12, originZ: -12, cols: 24, rows: 24, cellSize: 1, maxDepth: 0.3 },
  });
  assert.ok(world.liquid !== null);

  let overflowEvents = 0;
  world.events.on('liquidOverflow', () => {
    overflowEvents += 1;
  });

  // 直接把一格灌爆
  world.liquid.depth[0] = 3;
  for (let i = 0; i < 10; i += 1) world.step(1 / 60);

  assert.ok(overflowEvents > 0, '溢出应转成 liquidOverflow 事件');
  assert.ok(world.liquid.overflows > 0);
});

test('液面：地形尺寸不符时抛错', () => {
  const liquid = makeLiquid();
  assert.throws(() => liquid.setTerrain(new Float32Array(3)), /尺寸不符/);
  liquid.setTerrain(new Float32Array(64));
  assert.equal(liquid.terrain[0], 0);
});
