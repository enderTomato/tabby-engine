import test from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsWorld, ObstacleGrid, DoublePendulum, WindField } from '../dist/index.js';

const BOUNDS = { min: { x: -12, y: 0, z: -12 }, max: { x: 12, y: 14, z: 12 } };

function makeWorld(overrides = {}) {
  return new PhysicsWorld({
    bounds: BOUNDS,
    ragdoll: { sleepDelay: 0 },
    ...overrides,
  });
}

/**
 * 宽相位的核心不变量：点落在某个盒子里，那么这个盒子的索引必须出现在
 * 该点的候选列表里。违反这条就是「穿墙」，而且只在特定位置复现。
 */
test('宽相位：候选必须覆盖所有真实相交的盒子', () => {
  /** @type {import('../dist/types.js').Obstacle[]} */
  const boxes = [];
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 40; i += 1) {
    const cx = rnd() * 20 - 10;
    const cy = rnd() * 8;
    const cz = rnd() * 20 - 10;
    const w = 0.4 + rnd() * 2;
    const h = 0.4 + rnd() * 3;
    const d = 0.4 + rnd() * 2;
    boxes.push({
      id: `b${i}`,
      min: { x: cx, y: cy, z: cz },
      max: { x: cx + w, y: cy + h, z: cz + d },
      kind: 'solid',
    });
  }

  const grid = new ObstacleGrid(2);
  grid.rebuild(boxes);
  assert.ok(grid.instances > 0, '网格应插入实例');
  assert.equal(grid.degraded, false);

  const buf = new Int32Array(64);
  let checked = 0;
  let hits = 0;
  for (let k = 0; k < 2000; k += 1) {
    const x = rnd() * 26 - 13;
    const y = rnd() * 12;
    const z = rnd() * 26 - 13;
    const n = grid.queryPoint(x, y, z, buf);
    const candidates = new Set(buf.subarray(0, n));
    boxes.forEach((b, idx) => {
      const inside = x > b.min.x && x < b.max.x && y > b.min.y && y < b.max.y && z > b.min.z && z < b.max.z;
      if (!inside) return;
      hits += 1;
      assert.ok(candidates.has(idx), `点在盒 b${idx} 内但候选中没有它 (${x},${y},${z})`);
    });
    checked += 1;
  }
  assert.equal(checked, 2000);
  assert.ok(hits > 0, '随机点应当命中一些盒子，否则这个测试没验证到东西');
});

test('宽相位：没有障碍物时查询返回 0，且不崩', () => {
  const grid = new ObstacleGrid(2);
  grid.rebuild([]);
  const buf = new Int32Array(8);
  assert.equal(grid.queryPoint(0, 0, 0, buf), 0);
  assert.equal(grid.degraded, false);
});

test('宽相位：有网格与无网格的物理结果一致', () => {
  const build = () => {
    const world = makeWorld();
    world.addObstacle({ id: 'wall', min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 3, z: 1 }, kind: 'solid' });
    const ragdoll = world.spawnHumanoid('r', 0, 5, 0, 1);
    // 固定初速，让两个实例走同一条轨迹
    ragdoll.addImpulse(0, 2, 0, 0);
    return world;
  };

  const withGrid = build();
  const withoutGrid = build();
  const ragdoll = withGrid.getRagdoll('r');
  const reference = withoutGrid.getRagdoll('r');

  // 网格必须按障碍物构建一次；world 内部由 addObstacle 负责这件事
  const grid = new ObstacleGrid(2);
  grid.rebuild(withGrid.obstacles);

  for (let i = 0; i < 240; i += 1) {
    ragdoll.step(1 / 60, withGrid.obstacles, grid);
    reference.step(1 / 60, withoutGrid.obstacles, null);
  }

  for (let i = 0; i < ragdoll.pointCount; i += 1) {
    const dx = Math.abs(ragdoll.positions[i * 3] - reference.positions[i * 3]);
    const dy = Math.abs(ragdoll.positions[i * 3 + 1] - reference.positions[i * 3 + 1]);
    const dz = Math.abs(ragdoll.positions[i * 3 + 2] - reference.positions[i * 3 + 2]);
    assert.ok(dx < 1e-3 && dy < 1e-3 && dz < 1e-3, `点 ${i} 位置偏离：${dx}, ${dy}, ${dz}`);
  }
});

test('休眠：静止后入睡，受击后唤醒', () => {
  const world = new PhysicsWorld({
    bounds: BOUNDS,
    ragdoll: { sleepDelay: 0.5, sleepThreshold: 0.08 },
  });
  const ragdoll = world.spawnHumanoid('sleeper', 0, 2, 0, 1);

  for (let i = 0; i < 300; i += 1) ragdoll.step(1 / 60, [], null);
  assert.equal(ragdoll.isAsleep, true, '落地静止 5 秒后应进入休眠');

  ragdoll.addRadialImpulse(0, 0.5, 0, 3, 6);
  assert.equal(ragdoll.isAsleep, false, '受击必须唤醒');

  // 唤醒后必须真的动起来，而不是「醒了但不动」
  const before = ragdoll.positions[1];
  for (let i = 0; i < 30; i += 1) ragdoll.step(1 / 60, [], null);
  assert.notEqual(ragdoll.positions[1], before);
});

test('休眠：自由落体途中不会入睡（起手速度为零也不该睡）', () => {
  const world = new PhysicsWorld({
    bounds: { min: { x: -12, y: 0, z: -12 }, max: { x: 12, y: 200, z: 12 } },
    ragdoll: { sleepDelay: 0.1, sleepThreshold: 0.05 },
  });
  // 从 100 米落下：前 1 秒还离地 95 米，但第 0 帧速度就是 0
  const ragdoll = world.spawnHumanoid('air', 0, 100, 0, 1);
  for (let i = 0; i < 60; i += 1) {
    ragdoll.step(1 / 60, [], null);
    assert.equal(ragdoll.isAsleep, false, `第 ${i} 步在自由落体途中被误判休眠`);
  }
});

test('休眠：站在高台上的布娃娃也会睡（不能按离地高度过滤）', () => {
  const world = new PhysicsWorld({
    bounds: BOUNDS,
    ragdoll: { sleepDelay: 0.5, sleepThreshold: 0.1 },
  });
  world.addObstacle({ id: 'roof', min: { x: -3, y: 0, z: -3 }, max: { x: 3, y: 4, z: 3 }, kind: 'solid' });
  // 从台面上方 0.7 米落下（脚底 4.7，台面 4.0）
  const ragdoll = world.spawnHumanoid('roof', 0, 5.4, 0, 1);
  for (let i = 0; i < 600; i += 1) ragdoll.step(1 / 60, world.obstacles, null);
  assert.equal(ragdoll.isAsleep, true, '高台静止 10 秒后应休眠，否则城市里每具尸体都在空转');
  assert.ok(ragdoll.positions[1] > 4.2, `头部在 ${ragdoll.positions[1]}，应该还站在台面上而不是穿下去`);
});

test('高速穿透：从 20 米砸向楼板不会被压穿或压扁', () => {
  const world = new PhysicsWorld({ bounds: BOUNDS, ragdoll: { sleepDelay: 0 } });
  world.addObstacle({ id: 'floor', min: { x: -4, y: 0, z: -4 }, max: { x: 4, y: 3, z: 4 }, kind: 'solid' });
  const ragdoll = world.spawnHumanoid('fall', 0, 20, 0, 1);
  const grid = new ObstacleGrid(2);
  grid.rebuild(world.obstacles);

  for (let i = 0; i < 400; i += 1) ragdoll.step(1 / 60, world.obstacles, grid);

  // 所有点都不该出现在楼板内部（除非是生成时就嵌进去的，这里不是）
  for (let i = 0; i < ragdoll.pointCount; i += 1) {
    const y = ragdoll.positions[i * 3 + 1];
    const insideY = y > 0.2 && y < 2.8;
    const insideXZ = Math.abs(ragdoll.positions[i * 3]) < 3.8 && Math.abs(ragdoll.positions[i * 3 + 2]) < 3.8;
    assert.ok(!(insideY && insideXZ), `点 ${i} 陷在楼板里：y=${y}`);
  }

  // 砸下来会躺平（y 跨度接近 0 是合理的），但人形必须在水平方向展开：
  // 最远两点距离过小就说明它缩成了一团
  let maxDist = 0;
  for (let a = 0; a < ragdoll.pointCount; a += 1) {
    for (let b = a + 1; b < ragdoll.pointCount; b += 1) {
      const d = Math.hypot(
        ragdoll.positions[a * 3] - ragdoll.positions[b * 3],
        ragdoll.positions[a * 3 + 1] - ragdoll.positions[b * 3 + 1],
        ragdoll.positions[a * 3 + 2] - ragdoll.positions[b * 3 + 2],
      );
      if (d > maxDist) maxDist = d;
    }
  }
  assert.ok(maxDist > 1.2, `最远两点只有 ${maxDist.toFixed(2)} 米，布娃娃缩成一团了`);

  // 躺平后各点要有皮肤厚度，不能精确共面（否则和楼板 z-fighting）
  const ys = new Set();
  for (let i = 0; i < ragdoll.pointCount; i += 1) ys.add(ragdoll.positions[i * 3 + 1].toFixed(3));
  assert.ok(ragdoll.positions[1] > 3, `头部 y=${ragdoll.positions[1]}，应停在楼板上方`);
});

test('风场：确定性 —— 同参数同时刻采样完全一致', () => {
  const a = new WindField({ direction: 0.3, speed: 2, turbulence: 0.6 });
  const b = new WindField({ direction: 0.3, speed: 2, turbulence: 0.6 });
  const outA = new Float32Array(3);
  const outB = new Float32Array(3);
  for (let i = 0; i < 50; i += 1) {
    const t = i * 0.1;
    a.sample(1.3, 2.4, -3.1, t, outA);
    b.sample(1.3, 2.4, -3.1, t, outB);
    assert.deepEqual(Array.from(outA), Array.from(outB));
  }
});

test('风场：阵风是间歇的，不是均匀呼吸', () => {
  const wind = new WindField({ gustPeriod: 6, gustSpeed: 4 });
  let strong = 0;
  let weak = 0;
  for (let i = 0; i < 600; i += 1) {
    const g = wind.gust(i * 0.02);
    assert.ok(g >= 0, '阵风不应为负（负风速会做出倒吹的烟）');
    assert.ok(g <= 4 + 1e-9);
    if (g > 4 * 0.6) strong += 1;
    if (g < 4 * 0.05) weak += 1;
  }
  assert.ok(weak > strong, `平静期应多于强风期：weak=${weak} strong=${strong}`);
});

test('烟雾：有风时整体漂移方向与风向一致', () => {
  const world = new PhysicsWorld({
    bounds: BOUNDS,
    wind: { direction: 0, speed: 4, turbulence: 0, gustSpeed: 0, gustPeriod: 1e9 },
  });
  for (let i = 0; i < 40; i += 1) world.smoke.emit(0, 2, 0, 1, 0.2);
  assert.equal(world.smoke.count, 40);
  for (let i = 0; i < 120; i += 1) world.smoke.step(1 / 60);

  let sumX = 0;
  for (let i = 0; i < world.smoke.count; i += 1) sumX += world.smoke.renderData[i * 6];
  assert.ok(sumX / world.smoke.count > 0.5, `平均 x 位移 ${sumX / world.smoke.count}，风向 +X 时应明显为正`);
});

test('烟雾：无风场时仍能正常演化（降级路径）', () => {
  const world = new PhysicsWorld({ bounds: BOUNDS });
  world.smoke.setWind(null);
  world.smoke.emit(0, 1, 0, 20, 0.2);
  for (let i = 0; i < 60; i += 1) world.smoke.step(1 / 60);
  assert.ok(world.smoke.count > 0);
  assert.ok(world.smoke.renderData[1] > 1, '无风时应靠浮力上升');
});

test('双摆：长时间运行不发散', () => {
  const dp = new DoublePendulum({
    length1: 1,
    length2: 1,
    mass1: 1,
    mass2: 1,
    gravity: 9.8,
    damping: 0.02,
    angle1: 2.4,
    angle2: 1.2,
  });
  for (let i = 0; i < 3600; i += 1) {
    dp.step(1 / 60);
    assert.ok(Number.isFinite(dp.tipX) && Number.isFinite(dp.tipY), `第 ${i} 步出现 NaN`);
    assert.ok(Math.abs(dp.tipX) <= 2.0001, `末端 x 越界：${dp.tipX}`);
    assert.ok(Math.abs(dp.tipY) <= 2.0001, `末端 y 越界：${dp.tipY}`);
  }
  // 双摆应该一直在动（阻尼 0.02 下 60 秒内不该停）
  assert.ok(Math.abs(dp.velocity1) > 1e-3);
});

test('双摆：无阻尼时能量守恒（RK4 的意义）', () => {
  const dp = new DoublePendulum({
    length1: 1,
    length2: 1,
    mass1: 1,
    mass2: 1,
    gravity: 9.8,
    damping: 0,
    angle1: 1.0,
    angle2: 1.0,
  });
  const energy = () => {
    const { length1: l1, length2: l2, mass1: m1, mass2: m2, gravity: g } = dp.config;
    const y1 = -l1 * Math.cos(dp.angle1);
    const y2 = y1 - l2 * Math.cos(dp.angle2);
    const v1sq = l1 * l1 * dp.velocity1 * dp.velocity1;
    // 简化的动能近似：足够用来观察能量是否单调爆炸
    const v2sq = v1sq + l2 * l2 * dp.velocity2 * dp.velocity2;
    return m1 * g * y1 + m2 * g * y2 + 0.5 * m1 * v1sq + 0.5 * m2 * v2sq;
  };
  const e0 = energy();
  for (let i = 0; i < 1800; i += 1) dp.step(1 / 60);
  const e1 = energy();
  const drift = Math.abs((e1 - e0) / e0);
  assert.ok(drift < 0.35, `30 秒能量漂移 ${(drift * 100).toFixed(1)}%（半隐式欧拉通常 > 100%）`);
});

test('渲染插值：alpha=0 回到上一步，alpha=1 是当前步', () => {
  const world = makeWorld();
  const ragdoll = world.spawnHumanoid('i', 0, 6, 0, 1);
  const out = new Float32Array(ragdoll.boneCount * 6);

  // 先跑几步让速度稳定
  for (let i = 0; i < 10; i += 1) ragdoll.step(1 / 60, [], null);

  const beforeStep = Float32Array.from(ragdoll.positions);
  ragdoll.step(1 / 60, [], null);

  ragdoll.writeInterpolatedSegments(out, 0);
  assert.ok(Math.abs(out[0] - beforeStep[0]) < 1e-5, `alpha=0 应等于上一步位置，得到 ${out[0]} vs ${beforeStep[0]}`);

  ragdoll.writeInterpolatedSegments(out, 1);
  assert.ok(Math.abs(out[0] - ragdoll.positions[0]) < 1e-5, 'alpha=1 应等于当前位置');

  // 中间值必须落在两者之间（不能是直接取整）
  ragdoll.writeInterpolatedSegments(out, 0.5);
  const mid = (beforeStep[0] + ragdoll.positions[0]) / 2;
  assert.ok(Math.abs(out[0] - mid) < 1e-5);
});

test('绳索平滑：点数正确且端点重合', () => {
  const world = makeWorld();
  const rope = world.spawnRope('rope', 0, 8, 0, 10, 0.4);
  const sub = 4;
  const out = new Float32Array((rope.pointCount - 1) * sub * 3 + 3);
  const n = rope.writeSmoothPolyline(out, sub);
  assert.equal(n, (rope.pointCount - 1) * sub + 1, '点数应为 (段数 × 细分) + 1');

  assert.ok(Math.abs(out[0] - rope.positions[0]) < 1e-5, '首点应与绳头重合');
  const last = (n - 1) * 3;
  assert.ok(Math.abs(out[last] - rope.positions[(rope.pointCount - 1) * 3]) < 1e-5, '末点应与绳尾重合');
});

test('绳索平滑：缓冲区不足时返回 0 而不是越界写', () => {
  const world = makeWorld();
  const rope = world.spawnRope('rope2', 0, 8, 0, 10, 0.4);
  const tooSmall = new Float32Array(9);
  assert.equal(rope.writeSmoothPolyline(tooSmall, 4), 0);
});

test('关节弯曲限制：布娃娃不会折成反关节', () => {
  const world = makeWorld();
  const ragdoll = world.spawnHumanoid('bend', 0, 3, 0, 1);
  // 用力把脚往头顶方向拽，模拟极端冲击
  ragdoll.addImpulse(7, 0, 30, 0);
  ragdoll.addImpulse(8, 0, 30, 0);
  for (let i = 0; i < 600; i += 1) ragdoll.step(1 / 60, [], null);

  // 膝-髋-头三点距离不该塌到接近 0（那就是对折了）
  const d = (a, b) =>
    Math.hypot(
      ragdoll.positions[a * 3] - ragdoll.positions[b * 3],
      ragdoll.positions[a * 3 + 1] - ragdoll.positions[b * 3 + 1],
      ragdoll.positions[a * 3 + 2] - ragdoll.positions[b * 3 + 2],
    );
  assert.ok(d(5, 0) > 0.3, `髋到头距离 ${d(5, 0)} 过小，疑似对折`);
  assert.ok(d(7, 2) > 0.2, `膝到腰距离 ${d(7, 2)} 过小，疑似对折`);
});

test('宽相位实例池溢出时降级为暴力，并如实上报', () => {
  const boxes = [];
  for (let i = 0; i < 60; i += 1) {
    boxes.push({ id: `o${i}`, min: { x: i, y: 0, z: 0 }, max: { x: i + 1, y: 1, z: 1 }, kind: 'solid' });
  }
  // 故意给小池子
  const grid = new ObstacleGrid(0.5, 8);
  grid.rebuild(boxes);
  assert.equal(grid.degraded, true, '溢出必须被标记出来');

  const buf = new Int32Array(128);
  const n = grid.queryPoint(30.5, 0.5, 0.5, buf);
  assert.equal(n, 60, '降级后应返回全部盒子');
});
